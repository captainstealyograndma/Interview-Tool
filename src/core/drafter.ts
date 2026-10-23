// Drafted answers: used only when the Sheet has no answer. The draft streams
// word by word. Personal facts may come only from your materials (Sheet,
// resume, cover letter, job posting) and from what has already come up in the
// interview; subject-matter content may come from general knowledge. After the
// draft is complete, every personal claim is checked against the materials and
// anything not found is marked "unverified" for a dotted underline.

import Anthropic from '@anthropic-ai/sdk';
import { renderCatalog } from './catalog';
import { materialsBlock, type Materials } from './materials';
import type { RouterModel } from './router';
import { words } from './text';
import type { Sheet } from './types';

export interface DraftRequest {
  question: string;
  /** Earlier interviewer turns, oldest first. */
  recent: string[];
  /** Text of pieces already shown in this interview (what you have said), oldest first. */
  said: string[];
  /** The Sheet's closest material, if any, so the draft can reuse your own words. */
  closest: { label: string; text: string }[];
}

export interface Drafter {
  /** Streams the draft; `onText` receives the full text so far on every update. */
  draft(req: DraftRequest, onText: (textSoFar: string) => void, signal?: AbortSignal): Promise<string>;
  warm(): Promise<void>;
}

export const DRAFTER_INSTRUCTIONS = `You write what a job candidate will say out loud, right now, in a live interview, in reply to a question their prepared Sheet does not cover. The candidate reads your words from a teleprompter, so write in the first person, in the candidate's plain spoken style (short sentences, no headings, no lists, no quotation marks, no stage directions), and keep it to 60-110 words unless the question is a quick factual one, which gets one or two sentences.

Hard rules:
1. Every personal fact (jobs, schools, classes, grades, dates, numbers, names, projects, what the candidate did, likes or has done) must come from the MATERIALS below or from what has already been said in this interview. Never invent, extend or guess a personal fact. If the materials don't say it, don't claim it.
2. Never contradict the materials.
3. For subject-matter questions (law, tax, finance, technical topics) you may draw on general knowledge, kept at the level of the candidate's Sheet, without attributing experiences to the candidate that the materials don't support. Prefer "the way I'd think about it is…" framing over claiming to have done something.
4. Reuse the candidate's own wording from the materials and the closest Sheet material wherever it fits.
5. If the question cannot be answered truthfully from the materials and general knowledge (for example, a personal preference the materials never mention), write a short, honest, graceful answer that stays within what is known, rather than inventing a specific.
6. Answer the question that was asked, in the first sentence. No preamble, no "great question".

Output only the words to say.`;

function requestText(req: DraftRequest): string {
  const lines: string[] = [];
  if (req.recent.length) {
    lines.push('Earlier interviewer turns (oldest first):');
    for (const t of req.recent) lines.push(`- ${t}`);
    lines.push('');
  }
  if (req.said.length) {
    lines.push('What the candidate has already said in this interview (from the Sheet, oldest first):');
    for (const t of req.said) lines.push(`- ${t}`);
    lines.push('');
  }
  if (req.closest.length) {
    lines.push("Closest material in the candidate's Sheet (reuse its wording where it fits):");
    for (const c of req.closest) lines.push(`[${c.label}] ${c.text}`);
    lines.push('');
  }
  lines.push(`The interviewer just asked: "${req.question}"`, '', 'Write what the candidate should say now.');
  return lines.join('\n');
}

export class ClaudeDrafter implements Drafter {
  private client: Anthropic;
  private system: Anthropic.TextBlockParam[];

  constructor(sheet: Sheet, materials: Materials, opts: { apiKey: string; model: RouterModel; timeoutMs?: number }) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 1, timeout: opts.timeoutMs ?? 20000 });
    this.model = opts.model;
    const grounding = ['=== THE CANDIDATE\'S SHEET (prepared answers, verbatim) ===', renderCatalog(sheet), '', materialsBlock(materials)].join('\n');
    this.system = [
      { type: 'text', text: DRAFTER_INSTRUCTIONS },
      { type: 'text', text: `MATERIALS\n\n${grounding}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ];
  }

  private model: RouterModel;

  async draft(req: DraftRequest, onText: (textSoFar: string) => void, signal?: AbortSignal): Promise<string> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: 600,
        system: this.system,
        messages: [{ role: 'user', content: requestText(req) }],
        output_config: { effort: 'low' },
        ...(this.model === 'claude-haiku-5-5' ? { thinking: { type: 'disabled' as const } } : {}),
      } as never,
      { signal },
    );
    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        onText(text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new Error('Claude declined to draft this answer.');
    return text.trim();
  }

  /** Writes the materials into the prompt cache before the first real question. */
  async warm(): Promise<void> {
    await this.client.messages.create({
      model: this.model,
      max_tokens: 0,
      system: this.system,
      messages: [{ role: 'user', content: 'warm' }],
      output_config: { effort: 'low' },
      ...(this.model === 'claude-haiku-5-5' ? { thinking: { type: 'disabled' as const } } : {}),
    } as never);
  }
}

// ---------------------------------------------------------------- claim check

export interface DraftSpan {
  text: string;
  unverified: boolean;
}

/** Numbers that follow these words are subject-matter references, not personal claims. */
const TECHNICAL_LEAD = /\b(section|sections|§|rule|rules|code|chapter|article|form|schedule|subchapter|part|title|reg|regs|regulation|regulations|treas|irc|usc|u\.s\.c|cfr|percent|%)\s*$/i;

/** Capitalized words that are not names: sentence starters, pronouns, general nouns. */
const NOT_A_NAME = new Set(
  (
    'i im ive id ill my me mine the a an and or but so if then when where what which who how why because honestly really actually ' +
    'yes no sure first second third one two three four five six seven eight nine ten last next now here there that this these those it its ' +
    'we our us you your they their he she his her at in on for with from by to of as into about over after before during since until ' +
    'monday tuesday wednesday thursday friday saturday sunday today tomorrow yesterday ' +
    'january february march april may june july august september october november december ' +
    'section rule code chapter article form schedule part title regulation regulations ' +
    'irs tax taxes law legal court courts corporate partnership income deal deals client clients team teams excel sql python'
  ).split(/\s+/),
);

const TOKEN = /\$?\d[\d,.]*%?|[A-Z][A-Za-z'\u2019.&-]*/g;

/**
 * Splits a finished draft into spans. Names, employers, acronyms and numbers
 * that appear in neither the materials nor the interview so far are marked
 * unverified. Subject-matter references ("Section 351", "40 percent") are not
 * personal claims and are left alone.
 */
export function checkClaims(draft: string, known: string): DraftSpan[] {
  const knownWords = new Set(words(known));
  const knownLower = known.toLowerCase();
  const isKnown = (text: string) => {
    if (knownLower.includes(text.toLowerCase())) return true;
    const ws = words(text).filter((w) => !NOT_A_NAME.has(w));
    return ws.length > 0 && ws.every((w) => knownWords.has(w));
  };

  // 1. Tokens that could be claims, with positions.
  const tokens: { start: number; end: number; text: string; number: boolean; skip: boolean }[] = [];
  for (const m of draft.matchAll(TOKEN)) {
    const start = m.index!;
    const text = m[0];
    const number = /^\$?\d/.test(text);
    const before = draft.slice(Math.max(0, start - 16), start);
    const sentenceStart = start === 0 || /[.!?:;"\u201c(]\s*$/.test(before) || /^\s*$/.test(before);
    const skip = number ? TECHNICAL_LEAD.test(before) : NOT_A_NAME.has(text.toLowerCase().replace(/[.,]+$/, '')) || (sentenceStart && NOT_A_NAME.has(text.toLowerCase()));
    tokens.push({ start, end: start + text.length, text, number, skip });
  }

  // 2. Group consecutive capitalized tokens (separated by whitespace only) into one name.
  const groups: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.skip) continue;
    if (t.number) {
      groups.push({ start: t.start, end: t.end, text: t.text });
      continue;
    }
    let j = i;
    while (j + 1 < tokens.length && !tokens[j + 1]!.number && !tokens[j + 1]!.skip && /^\s+$/.test(draft.slice(tokens[j]!.end, tokens[j + 1]!.start))) j++;
    groups.push({ start: t.start, end: tokens[j]!.end, text: draft.slice(t.start, tokens[j]!.end) });
    i = j;
  }

  // 3. Spans.
  const spans: DraftSpan[] = [];
  let last = 0;
  for (const g of groups) {
    const clean = g.text.replace(/[.,;:]+$/, '');
    const numberKnown = knownLower.includes(clean.replace(/[%$,]/g, '').toLowerCase());
    if (isKnown(clean) || numberKnown) continue;
    const end = g.start + clean.length;
    if (g.start > last) spans.push({ text: draft.slice(last, g.start), unverified: false });
    spans.push({ text: clean, unverified: true });
    last = end;
  }
  if (last < draft.length) spans.push({ text: draft.slice(last), unverified: false });
  return spans.length ? spans : [{ text: draft, unverified: false }];
}
