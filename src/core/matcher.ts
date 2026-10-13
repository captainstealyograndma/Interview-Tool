// Instant on-device matcher: runs on every partial transcript in well under a
// millisecond per piece. It is the early (dimmed) guess and the offline fallback;
// Claude confirms the pick when the interviewer stops talking.

import { ASK_PROMPT, BEHAVIORAL, DIRECT, MORE, RESUME, tokens } from './text';
import type { Piece, Sheet } from './types';

export interface MatchResult {
  ids: string[];
  score: number;
  margin: number;
  runnerUp?: string;
  ranked: { id: string; score: number }[];
}

export interface MatchContext {
  /** Pieces shown so far in this interview, most recent last. */
  shown: string[];
}

interface Doc {
  id: string;
  toks: string[];
  weight: number;
}

const ROUTABLE: Piece['kind'][] = ['answer', 'story', 'followup', 'finder', 'resume', 'technical', 'conditional'];

export class Matcher {
  private docs: Doc[] = [];
  private idf = new Map<string, number>();
  private readonly askIds: string[];

  constructor(
    private sheet: Sheet,
    extraPrompts: Record<string, string[]> = {},
  ) {
    for (const id of sheet.order) {
      const piece = sheet.pieces[id]!;
      if (!ROUTABLE.includes(piece.kind)) continue;
      const prompts = [...piece.prompts, ...(extraPrompts[id] ?? [])];
      if (piece.kind === 'resume' && piece.group) prompts.push(`${piece.group} ${piece.title}`);
      for (const p of prompts) {
        const toks = [...new Set(tokens(p))];
        if (toks.length) this.docs.push({ id, toks, weight: extraPrompts[id]?.includes(p) ? 0.95 : 1 });
      }
      // Short factual pieces are also findable by their own words ("What's a 338(h)(10) election?").
      if (piece.kind === 'technical' || piece.kind === 'resume' || piece.kind === 'conditional') {
        const body = piece.blocks
          .flatMap((b) => b.segments)
          .filter((s) => s.kind === 'say')
          .map((s) => sheet.paras[s.para]!.text.slice(s.start, s.end))
          .join(' ');
        const toks = [...new Set(tokens(body))];
        if (toks.length) this.docs.push({ id, toks, weight: 0.6 });
      }
    }
    const df = new Map<string, number>();
    for (const d of this.docs) for (const t of d.toks) df.set(t, (df.get(t) ?? 0) + 1);
    const n = this.docs.length || 1;
    for (const [t, c] of df) this.idf.set(t, Math.log(1 + n / c));
    this.askIds = sheet.order.filter((id) => sheet.pieces[id]!.kind === 'ask');
  }

  private w(t: string): number {
    return this.idf.get(t) ?? Math.log(1 + this.docs.length);
  }

  match(text: string, ctx: MatchContext = { shown: [] }): MatchResult {
    if (ASK_PROMPT.test(text) && this.askIds.length) {
      return { ids: this.askIds, score: 1, margin: 1, ranked: [{ id: this.askIds[0]!, score: 1 }] };
    }
    const q = [...new Set(tokens(text))];
    const qNorm = Math.sqrt(q.reduce((s, t) => s + this.w(t) ** 2, 0)) || 1;
    const behavioral = BEHAVIORAL.test(text);
    const direct = !behavioral && DIRECT.test(text.trim());
    const wantsMore = MORE.test(text);
    const resume = RESUME.test(text);
    const last = ctx.shown[ctx.shown.length - 1];
    const lastPiece = last ? this.sheet.pieces[last] : undefined;
    const lastStory = lastPiece ? (lastPiece.parent ?? lastPiece.id) : undefined;
    const linkedFromLast = new Set(lastPiece?.links.map((l) => l.target) ?? []);

    const best = new Map<string, number>();
    for (const d of this.docs) {
      let dot = 0;
      for (const t of d.toks) if (q.includes(t)) dot += this.w(t) ** 2;
      if (!dot) continue;
      const dNorm = Math.sqrt(d.toks.reduce((s, t) => s + this.w(t) ** 2, 0)) || 1;
      const sim = (dot / (qNorm * dNorm)) * d.weight;
      if (sim > (best.get(d.id) ?? 0)) best.set(d.id, sim);
    }

    // Context and question-type priors.
    if (wantsMore && lastPiece) {
      for (const t of linkedFromLast) best.set(t, Math.max(best.get(t) ?? 0, 0.6));
    }
    const ranked = [...best.entries()]
      .map(([id, score]) => {
        const piece = this.sheet.pieces[id]!;
        let s = score;
        if (behavioral) {
          if (piece.kind === 'finder') s *= 1.25;
          else if (piece.kind === 'answer') s *= 0.85;
        } else if (direct) {
          if (piece.kind === 'answer' || piece.kind === 'technical') s *= 1.15;
          if (piece.kind === 'finder') s *= 0.95;
        }
        if (resume && piece.kind === 'resume') s *= 1.3;
        if (piece.kind === 'followup' || piece.kind === 'conditional') {
          s *= piece.parent && (piece.parent === lastStory || piece.parent === last) ? 1.6 : 0.7;
        }
        if (piece.kind === 'story' && ctx.shown.includes(id) && !wantsMore) s *= 0.8;
        return { id, score: Math.min(1, s) };
      })
      .sort((a, b) => b.score - a.score);

    // For "tell me about a time" questions, the Sheet says to use the Question Finder:
    // prefer a close Finder entry over a story or answer picked directly.
    if (behavioral && ranked[0] && this.sheet.pieces[ranked[0].id]!.kind !== 'finder') {
      const finder = ranked.find((r) => this.sheet.pieces[r.id]!.kind === 'finder');
      if (finder && finder.score >= 0.8 * ranked[0].score) {
        ranked.splice(ranked.indexOf(finder), 1);
        ranked.unshift(finder);
      }
    }
    const top = ranked[0];
    const second = ranked.find((r) => r.id !== top?.id && !this.sameFamily(r.id, top?.id));
    return {
      ids: top ? [top.id] : [],
      score: top?.score ?? 0,
      margin: (top?.score ?? 0) - (second?.score ?? 0),
      ...(second ? { runnerUp: second.id } : {}),
      ranked: ranked.slice(0, 8),
    };
  }

  private sameFamily(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    const pa = this.sheet.pieces[a];
    const pb = this.sheet.pieces[b];
    if (!pa || !pb) return false;
    // A Question Finder entry and the story it expands to are the same answer.
    const primaryA = pa.links.find((l) => l.rel === 'primary')?.target;
    const primaryB = pb.links.find((l) => l.rel === 'primary')?.target;
    return primaryA === b || primaryB === a;
  }
}
