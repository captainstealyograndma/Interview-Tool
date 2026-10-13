// Claude router: given what the interviewer said, returns piece ids from the
// Sheet (never text). The Sheet catalog sits in a cached system block so each
// question only sends the short conversation context.

import Anthropic from '@anthropic-ai/sdk';
import { renderCatalog, routableIds } from './catalog';
import type { Sheet } from './types';

export type RouterModel = 'claude-opus-5-5' | 'claude-haiku-5-5';

export interface RouteRequest {
  question: string;
  /** Earlier interviewer turns, oldest first. */
  recent: string[];
  /** Pieces already shown, oldest first. */
  shown: { id: string; label: string }[];
}

export interface RouteDecision {
  action: 'show' | 'not_in_sheet' | 'ignore';
  ids: string[];
  closest: string[];
  runnerUp: string;
  bridge: string;
  suggestedQuestion: string;
  latencyMs: number;
  model: string;
  cacheReadTokens?: number;
}

export interface Router {
  route(req: RouteRequest, signal?: AbortSignal): Promise<RouteDecision>;
  warm(): Promise<void>;
}

export const ROUTER_INSTRUCTIONS = `You route live interview questions to the candidate's own prepared answers. The candidate reads your selection aloud from a teleprompter, so every word must come from their Sheet exactly as written. You never write answer text. You only choose ids from the Sheet catalog that follows.

Each request gives you what the interviewer just said, earlier interviewer turns, and which pieces have already been shown. Choose one action:
- "show": the interviewer asked the candidate something the Sheet answers. Put the ids to show, in order, in "ids".
- "not_in_sheet": the interviewer asked the candidate something the Sheet does not answer. Put up to two closest ids in "closest". Do not stretch a loosely related piece into an answer; flagging is better than showing the wrong script.
- "ignore": small talk with no Sheet answer, the interviewer describing themselves, the team, the role or the firm, acknowledgements ("great", "thanks", "mm-hmm"), or anything that is not a question or prompt for the candidate.

How to choose, following the Sheet's own guidance first:
1. Behavioral questions ("tell me about a time", "give me an example", "describe a situation"): choose the Question Finder entry [Q…] that matches what they asked. It already expands to its opening line plus the story the Sheet names, so do not add that story again. If no entry matches but a story's "use it for" fits, choose the story [S…] directly.
2. Direct questions ("what's your…", "why…", "how do you…", "where do you see yourself…"): choose the Core narrative, Classic or Tough answer whose question matches. Prefer these over Question Finder entries when the question is not asking for an example.
3. Short follow-ups ("who won?", "what would you do differently?", "how did that feel?") refer to what was just shown: choose that story's follow-up [S….F…] when one fits.
4. "Tell me more", "go on", "what happened": choose the piece that the last shown piece points to.
5. When the interviewer points to a resume line or past job, choose the Resume Walkthrough piece [R…]. If they then ask for more, choose the story it points to.
6. Conditional answers [….I…] only when the interviewer asks exactly that.
7. Technical talking points [X…] only when the interviewer goes technical.
8. When the interviewer asks whether the candidate has questions for them, return the Questions to ask [A…] in order.
9. Return more than one id only when the interviewer asked two things at once or the Sheet says to combine them. Never return content twice.

"runner_up": the second-best id to show, or "".

"bridge": almost always "". Only when the first piece you return would sound like a non-sequitur as a direct reply to the exact question (typically a story chosen directly because no opening line covers the question), write a lead-in of at most 15 words that flows into it. Use only words from the interviewer's question, words from the chosen text, and plain connecting words. Never add facts, names, numbers, opinions or claims. If unsure, return "".

"suggested_question": almost always "". Only when the interviewer just shared something specific about the team, the role, the work or the firm, suggest one short, natural question the candidate could ask later about that specific thing. Otherwise "".`;

function schemaFor(ids: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'ids', 'closest', 'runner_up', 'bridge', 'suggested_question'],
    properties: {
      action: { type: 'string', enum: ['show', 'not_in_sheet', 'ignore'] },
      ids: { type: 'array', items: { type: 'string', enum: ids } },
      closest: { type: 'array', items: { type: 'string', enum: ids } },
      runner_up: { type: 'string', enum: ['', ...ids] },
      bridge: { type: 'string' },
      suggested_question: { type: 'string' },
    },
  } as const;
}

export function requestText(req: RouteRequest): string {
  const lines: string[] = [];
  if (req.recent.length) {
    lines.push('Earlier interviewer turns (oldest first):');
    for (const t of req.recent) lines.push(`- ${t}`);
  }
  lines.push(
    req.shown.length ? `Already shown (oldest first): ${req.shown.map((s) => `${s.id} (${s.label})`).join('; ')}` : 'Already shown: nothing yet',
  );
  lines.push('', `The interviewer just said: "${req.question}"`);
  return lines.join('\n');
}

export class ClaudeRouter implements Router {
  private client: Anthropic;
  private catalog: string;
  private ids: string[];
  private fallbacksSupported = true;

  constructor(
    private sheet: Sheet,
    private opts: { apiKey: string; model: RouterModel; timeoutMs?: number },
  ) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 1, timeout: opts.timeoutMs ?? 8000 });
    this.catalog = renderCatalog(sheet);
    this.ids = routableIds(sheet);
  }

  private params(req: RouteRequest) {
    const base = {
      model: this.opts.model,
      max_tokens: 2000,
      system: [
        { type: 'text' as const, text: ROUTER_INSTRUCTIONS },
        { type: 'text' as const, text: this.catalog, cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } },
      ],
      messages: [{ role: 'user' as const, content: requestText(req) }],
      output_config: {
        effort: 'low' as const,
        format: { type: 'json_schema' as const, schema: schemaFor(this.ids) as unknown as Record<string, unknown> },
      },
    };
    // Claude Haiku 5.5 can run without thinking at low effort (fastest); Claude Opus 5.5 always thinks, so effort is the control.
    return this.opts.model === 'claude-haiku-5-5' ? { ...base, thinking: { type: 'disabled' as const } } : base;
  }

  private async call(req: RouteRequest, signal?: AbortSignal): Promise<Anthropic.Message> {
    const params = this.params(req);
    // Claude Opus 5.5: opt into server-side refusal fallback (routes a declined request to another model).
    if (this.opts.model === 'claude-opus-5-5' && this.fallbacksSupported) {
      try {
        return (await this.client.beta.messages.create(
          { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as never,
          { signal },
        )) as unknown as Anthropic.Message;
      } catch (e) {
        if (e instanceof Anthropic.BadRequestError) this.fallbacksSupported = false;
        else throw e;
      }
    }
    return this.client.messages.create(params as never, { signal }) as Promise<Anthropic.Message>;
  }

  async route(req: RouteRequest, signal?: AbortSignal): Promise<RouteDecision> {
    const t0 = performance.now();
    const res = await this.call(req, signal);
    const latencyMs = Math.round(performance.now() - t0);
    if (res.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text) as {
      action: RouteDecision['action'];
      ids: string[];
      closest: string[];
      runner_up: string;
      bridge: string;
      suggested_question: string;
    };
    const valid = (xs: string[]) => xs.filter((x) => this.sheet.pieces[x]);
    return {
      action: parsed.action,
      ids: valid(parsed.ids),
      closest: valid(parsed.closest).slice(0, 2),
      runnerUp: this.sheet.pieces[parsed.runner_up] ? parsed.runner_up : '',
      bridge: parsed.bridge ?? '',
      suggestedQuestion: parsed.suggested_question ?? '',
      latencyMs,
      model: res.model,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    };
  }

  /** Writes the Sheet into the prompt cache before the first real question. */
  async warm(): Promise<void> {
    await this.route({ question: 'Hi, thanks for joining today.', recent: [], shown: [] });
  }
}

/**
 * Load-time only: alternative ways an interviewer might ask for each piece.
 * Used to improve the instant on-device matcher. Never displayed.
 */
export async function generatePhrasings(
  sheet: Sheet,
  opts: { apiKey: string; model: RouterModel },
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, string[]>> {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 180_000 });
  const catalog = renderCatalog(sheet);
  const targets = sheet.order.filter((id) => !['ask'].includes(sheet.pieces[id]!.kind));
  const batches: string[][] = [];
  for (let i = 0; i < targets.length; i += 30) batches.push(targets.slice(i, i + 30));
  let done = 0;
  const results = await Promise.all(
    batches.map(async (batch) => {
      const res = await client.messages.create({
        model: opts.model,
        max_tokens: 16000,
        system: [{ type: 'text', text: catalog, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: `For each of these piece ids, write 4 different, natural ways a live interviewer might ask for that piece (vary wording; include short spoken forms). These are used only to recognize questions, never shown. Ids: ${batch.join(', ')}`,
          },
        ],
        output_config: {
          effort: 'low',
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'phrasings'],
                    properties: { id: { type: 'string', enum: batch }, phrasings: { type: 'array', items: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      } as never);
      const msg = res as unknown as Anthropic.Message;
      const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '{"items":[]}';
      done += batch.length;
      onProgress?.(done, targets.length);
      return (JSON.parse(text) as { items: { id: string; phrasings: string[] }[] }).items;
    }),
  );
  const out: Record<string, string[]> = {};
  for (const item of results.flat()) if (sheet.pieces[item.id]) out[item.id] = item.phrasings.slice(0, 6);
  return out;
}
