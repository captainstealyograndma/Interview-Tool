// The live session: turns transcript events into what the banner shows.
//
// - While the interviewer talks, the instant matcher shows a dimmed early guess.
// - When they finish, Claude's pick (piece ids only) is rendered from the Sheet
//   and locks in. If Claude is slow or unreachable, the instant match is used.
// - Once you scroll a script, nothing replaces it until the next question.
// - Interviewer turns that arrive in pieces (a preamble, then the question, then
//   "what was the situation?") are joined back into one question. Joining stops
//   at an interviewer "mm-hmm" (you are talking), at an answer shown more than a
//   few seconds ago, and after 20 seconds in all.
// - A follow-up or conditional answer is never shown unless its story was just
//   shown; a behavioral question never gets a follow-up or resume line.
// - When the Sheet has no answer and a drafter is available, a drafted answer
//   streams in, styled apart, with unverified personal claims marked.

import { EventEmitter } from 'node:events';
import { validateBridge } from './bridge';
import { displayText } from './catalog';
import { checkClaims, type Drafter } from './drafter';
import type { Matcher, MatchResult } from './matcher';
import type { RouteDecision, RouteRequest, Router } from './router';
import { expandIds, pieceLabel, renderPlan, type Script, type ScriptBlock } from './script';
import { BEHAVIORAL, DIRECT, isBackchannel, looksLikeQuestion, wordCount } from './text';
import type { Sheet } from './types';

export type TurnEventType = 'start' | 'update' | 'eager-end' | 'resumed' | 'end';

export interface TurnEvent {
  type: TurnEventType;
  turn: number;
  text: string;
}

export type BannerMode = 'idle' | 'provisional' | 'confirmed' | 'not-in-sheet' | 'drafted';
export type BannerSource = 'instant' | 'claude' | 'offline' | 'manual';

export interface BannerView {
  mode: BannerMode;
  source: BannerSource;
  label: string;
  cues: string[];
  blocks: ScriptBlock[];
  /** For "not in Sheet": the closest material, clearly labeled. */
  closest: { id: string; label: string; blocks: ScriptBlock[] }[];
  /** Stories referred to by underlined phrases that have not been shown yet. */
  unmetBackrefs: string[];
  /** Ids of the pieces on screen, in order ('draft' for a drafted answer). */
  pieces: string[];
  runnerUp?: { id: string; label: string };
  confidence?: number;
  latencyMs?: number;
  /** Drafted mode: still streaming. */
  drafting?: boolean;
  question: string;
  turn: number;
  version: number;
}

export interface DraftSupport {
  drafter: Drafter;
  /** Everything a draft may state as personal fact: materials and Sheet text. Used by the claim check. */
  knownText: string;
}

export interface TrayView {
  sheetQuestions: { id: string; text: string; note?: string }[];
  suggestions: string[];
}

export interface StatusView {
  transcript: string;
  routerState: 'off' | 'ok' | 'error';
  lastLatencyMs?: number;
  message?: string;
}

export interface EngineOptions {
  /** Minimum instant-match score to show a dimmed early guess. */
  provisionalMin: number;
  /** Minimum instant-match score to show an answer when Claude is unavailable. */
  offlineMin: number;
  /** If Claude hasn't answered after this long, show a confident instant match meanwhile (Claude keeps working). */
  routerTimeoutMs: number;
  /** Stop waiting for Claude on a question after this long. */
  routerGiveUpMs: number;
  /** Don't swap in an early guess within this long after you scrolled. */
  scrollQuietMs: number;
  /** Interviewer turns that start within this long after the previous one ended are one question. */
  clusterGapMs: number;
  /** Pieces of one question never span more than this, first word to last. */
  clusterMaxSpanMs: number;
  /** A turn whose answer was shown longer ago than this is a finished question; later turns are new. */
  answeredStaleMs: number;
}

const DEFAULTS: EngineOptions = {
  provisionalMin: 0.4,
  offlineMin: 0.45,
  routerTimeoutMs: 3500,
  routerGiveUpMs: 15000,
  scrollQuietMs: 4000,
  clusterGapMs: 4000,
  clusterMaxSpanMs: 20000,
  answeredStaleMs: 10000,
};

const SLOW = Symbol('slow');
const after = (ms: number) => new Promise<typeof SLOW>((r) => setTimeout(() => r(SLOW), ms));

interface Pending {
  text: string;
  controller: AbortController;
  promise: Promise<RouteDecision | null>;
  error?: unknown;
}

type Outcome = 'show' | 'drafted' | 'ignore' | 'backchannel' | 'none';

const DRAFT_UPDATE_MS = 90;

/**
 * A short tail that only makes sense with the question just asked ("What was the
 * situation? And how did you handle it?"). Anything that could be a new question
 * ("And also, tell me about your grades", "How about a time you failed?") is not one.
 */
const FRAGMENT_START = /^(and|or|so|what|how|why|which|that|then|but|plus|was|were|did|do|does)\b/i;
const NEW_QUESTION_MARKERS = /\b(tell|describe|give|walk|share|talk|example|a time|about a|another|also|next|what about|how about|instead|different|other|your|you've|you have|have you|did you ever|can you|could you|would you)\b/i;
const FRAGMENT_MAX_WORDS = 12;

export class Engine extends EventEmitter {
  private opts: EngineOptions;
  private view: BannerView;
  private lastConfirmed: BannerView;
  private tray: TrayView;
  private status: StatusView;
  private shown: string[] = [];
  /** Final turns in order, with their text and what came of them. */
  private finals: { turn: number; text: string }[] = [];
  private turnStart = new Map<number, number>();
  private turnEnd = new Map<number, number>();
  private outcome = new Map<number, Outcome>();
  private isolated = new Set<number>();
  private latestEnded = -1;
  private pending = new Map<number, Pending>();
  private lastScrollAt = 0;
  private viewShownAt = 0;
  private version = 0;
  private draftController?: AbortController;
  private draftPromise?: Promise<void>;

  constructor(
    private sheet: Sheet,
    private matcher: Matcher,
    private router: Router | null,
    opts: Partial<EngineOptions> = {},
    private draft: DraftSupport | null = null,
  ) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.view = this.emptyView();
    this.lastConfirmed = this.view;
    this.tray = {
      sheetQuestions: sheet.order
        .filter((id) => sheet.pieces[id]!.kind === 'ask')
        .map((id) => {
          const p = sheet.pieces[id]!;
          return { id, text: p.title, ...(p.notes[0] ? { note: p.notes[0] } : {}) };
        }),
      suggestions: [],
    };
    this.status = { transcript: '', routerState: router ? 'ok' : 'off' };
  }

  get banner(): BannerView {
    return this.view;
  }
  get trayView(): TrayView {
    return this.tray;
  }
  get statusView(): StatusView {
    return this.status;
  }
  get shownPieces(): string[] {
    return [...this.shown];
  }

  private emptyView(): BannerView {
    return { mode: 'idle', source: 'instant', label: '', cues: [], blocks: [], closest: [], unmetBackrefs: [], pieces: [], question: '', turn: -1, version: 0 };
  }

  private setView(v: Omit<BannerView, 'version'>) {
    this.view = { ...v, version: ++this.version };
    this.viewShownAt = Date.now();
    if (v.mode === 'confirmed' || v.mode === 'not-in-sheet' || v.mode === 'drafted') this.lastConfirmed = this.view;
    this.emit('banner', this.view);
  }

  private setStatus(patch: Partial<StatusView>) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  private log(msg: string, data?: unknown) {
    this.emit('log', { at: Date.now(), msg, data });
  }

  // ---------------------------------------------------------------- input

  handle(ev: TurnEvent): void {
    if (!this.turnStart.has(ev.turn)) this.turnStart.set(ev.turn, Date.now());
    switch (ev.type) {
      case 'start':
      case 'update':
        this.setStatus({ transcript: ev.text });
        this.onPartial(ev.turn, ev.text);
        break;
      case 'eager-end':
        this.setStatus({ transcript: ev.text });
        this.startRoute(ev.turn, ev.text);
        break;
      case 'resumed':
        break;
      case 'end':
        this.turnEnd.set(ev.turn, Date.now());
        this.setStatus({ transcript: ev.text });
        void this.onFinal(ev.turn, ev.text);
        break;
    }
  }

  /** Call when you scroll the banner: the current script is now locked. */
  userScrolled(): void {
    this.lastScrollAt = Date.now();
  }

  /** Swap to the runner-up (one click). */
  showRunnerUp(): void {
    const r = this.view.runnerUp;
    if (!r) return;
    const previous = { id: this.view.blocks[0]?.piece ?? '', label: this.view.label };
    this.showIds([r.id], { source: 'manual', question: this.view.question, turn: this.view.turn, runnerUp: previous.id ? previous : undefined });
  }

  /** Show a piece directly (from the review screen or the questions tray). */
  showPiece(id: string): void {
    this.showIds([id], { source: 'manual', question: '', turn: this.view.turn });
  }

  /** Test mode: treat typed text as a complete interviewer turn on its own. */
  async simulate(text: string): Promise<void> {
    const turn = Math.max(this.latestEnded, this.view.turn) + 1;
    this.isolated.add(turn);
    this.handle({ type: 'start', turn, text });
    this.turnEnd.set(turn, Date.now());
    await this.onFinal(turn, text);
    await this.draftPromise;
  }

  // ---------------------------------------------------------------- turns that arrive in pieces

  /** Earlier turns that belong to the same question as `turn` (oldest first). */
  private clusterBefore(turn: number): { turn: number; text: string }[] {
    if (this.isolated.has(turn)) return [];
    const out: { turn: number; text: string }[] = [];
    const start = this.turnStart.get(turn) ?? 0;
    let cur = turn;
    for (let i = this.finals.length - 1; i >= 0; i--) {
      const prev = this.finals[i]!;
      if (prev.turn >= cur) continue;
      if (this.isolated.has(prev.turn)) break;
      const outcome = this.outcome.get(prev.turn) ?? 'none';
      // "Mm-hmm", "right": the interviewer is listening to you answer. Whatever came before is done.
      // An answered question is closed too: only unanswered pieces (a preamble, a half sentence) are joined.
      if (outcome === 'backchannel' || outcome === 'show' || outcome === 'drafted') break;
      const prevEnd = this.turnEnd.get(prev.turn) ?? 0;
      if ((this.turnStart.get(cur) ?? 0) - prevEnd > this.opts.clusterGapMs) break;
      if (start - (this.turnStart.get(prev.turn) ?? 0) > this.opts.clusterMaxSpanMs) break;
      out.unshift(prev);
      cur = prev.turn;
    }
    return out;
  }

  /** What the interviewer has said across this question's pieces, as one text. */
  private questionFor(turn: number, text: string): string {
    const before = this.clusterBefore(turn).map((t) => t.text.trim());
    return [...before, text.trim()].filter(Boolean).join(' ');
  }

  private isFragment(text: string): boolean {
    const t = text.trim();
    return wordCount(t) <= FRAGMENT_MAX_WORDS && FRAGMENT_START.test(t) && !NEW_QUESTION_MARKERS.test(t);
  }

  // ---------------------------------------------------------------- partials

  private onPartial(turn: number, text: string) {
    if (wordCount(text) < 5 || isBackchannel(text)) return;
    const question = this.questionFor(turn, text);
    // Comments ("That's a great example") never cover the script you're reading; only questions do.
    if (!looksLikeQuestion(question)) return;
    if (this.view.turn === turn && this.view.mode !== 'provisional') return; // already confirmed this turn
    if (Date.now() - this.lastScrollAt < this.opts.scrollQuietMs) return; // you're reading
    const m = this.matcher.match(question, { shown: this.shown });
    if (m.score < this.opts.provisionalMin || !m.ids.length) return;
    if (!this.allowed(question, m.ids).ok) return;
    const first = this.firstPiece(m.ids);
    if (this.view.mode === 'provisional' && this.view.turn === turn && this.view.blocks[0]?.piece === first) return;
    // The same script is already confirmed from this question's earlier piece: leave it alone.
    if (this.view.mode === 'confirmed' && this.view.blocks[0]?.piece === first && this.clusterBefore(turn).some((t) => t.turn === this.view.turn)) return;
    const script = this.render(m.ids);
    if (!script) return;
    this.setView({
      mode: 'provisional',
      source: 'instant',
      label: script.label,
      cues: script.cues,
      blocks: script.blocks,
      closest: [],
      unmetBackrefs: this.unmet(script, false),
      pieces: script.pieces,
      ...(m.runnerUp ? { runnerUp: { id: m.runnerUp, label: pieceLabel(this.sheet, m.runnerUp) } } : {}),
      confidence: m.score,
      question,
      turn,
    });
  }

  private firstPiece(ids: string[]): string | undefined {
    const parts = expandIds(this.sheet, ids);
    return parts[0]?.piece;
  }

  // ---------------------------------------------------------------- routing

  private context(turn: number, question: string, note?: string): RouteRequest {
    const cluster = new Set(this.clusterBefore(turn).map((t) => t.turn));
    return {
      question,
      recent: this.finals
        .filter((t) => t.turn < turn && !cluster.has(t.turn))
        .slice(-6)
        .map((t) => t.text),
      shown: this.shown.slice(-10).map((id) => ({ id, label: pieceLabel(this.sheet, id) })),
      ...(note ? { note } : {}),
    };
  }

  private startRoute(turn: number, text: string): Pending | undefined {
    if (!this.router || isBackchannel(text)) return undefined;
    // A new question ends any draft still streaming for an older one.
    if (this.draftController && this.view.turn !== turn) this.draftController.abort();
    const existing = this.pending.get(turn);
    if (existing && existing.text === text) return existing;
    existing?.controller.abort();
    const controller = new AbortController();
    const p: Pending = {
      text,
      controller,
      promise: this.router.route(this.context(turn, this.questionFor(turn, text)), controller.signal).catch((e) => {
        p.error = e;
        return null;
      }),
    };
    this.pending.set(turn, p);
    return p;
  }

  private async onFinal(turn: number, text: string) {
    this.latestEnded = Math.max(this.latestEnded, turn);
    if (isBackchannel(text)) {
      this.finals.push({ turn, text });
      this.outcome.set(turn, 'backchannel');
      if (this.view.mode === 'provisional' && this.view.turn === turn) this.revert();
      return;
    }
    // "What was the situation? And how did you handle it?" right after the question it belongs to:
    // the answer is already showing. Keep it; don't ask again.
    const last = this.finals[this.finals.length - 1];
    const answered =
      last &&
      !this.isolated.has(turn) &&
      ['show', 'drafted'].includes(this.outcome.get(last.turn) ?? 'none') &&
      (this.turnStart.get(turn) ?? 0) - (this.turnEnd.get(last.turn) ?? 0) <= this.opts.clusterGapMs
        ? last
        : undefined;
    if (answered && this.isFragment(text) && this.view.turn === answered.turn && ['confirmed', 'drafted'].includes(this.view.mode)) {
      this.pending.get(turn)?.controller.abort();
      this.pending.delete(turn);
      this.finals.push({ turn, text });
      this.outcome.set(turn, this.outcome.get(answered.turn)!);
      this.adoptTurn(turn, this.questionFor(turn, text));
      this.log('continuation', { turn, text });
      return;
    }
    const question = this.questionFor(turn, text);
    const pending = this.startRoute(turn, text);
    this.finals.push({ turn, text });
    this.outcome.set(turn, 'none');
    if (!pending) {
      if (turn < this.latestEnded) return; // a newer question already arrived
      this.applyInstant(turn, question, 'instant', true);
      return;
    }
    const first = await Promise.race([pending.promise, after(this.opts.routerTimeoutMs)]);
    if (first !== SLOW) {
      this.pending.delete(turn);
      await this.finish(turn, question, text, first, pending, false);
      return;
    }
    // Claude is slow. Show a confident instant match meanwhile (never a "Not in Sheet" flag),
    // and keep waiting: Claude's answer is never thrown away just for being slow.
    this.setStatus({ routerState: 'ok', message: 'Claude is taking a little longer; the banner updates when it answers.' });
    this.log('router-slow', { turn });
    if (turn >= this.latestEnded) this.applyInstant(turn, question, 'instant', false);
    const late = await Promise.race([pending.promise, after(Math.max(0, this.opts.routerGiveUpMs - this.opts.routerTimeoutMs))]);
    this.pending.delete(turn);
    if (late === SLOW) {
      pending.controller.abort();
      await this.finish(turn, question, text, null, pending, true, 'no answer after 15 seconds');
      return;
    }
    await this.finish(turn, question, text, late, pending, true);
  }

  /** The current script now also answers `turn` (a later piece of the same question). No re-render. */
  private adoptTurn(turn: number, question: string) {
    this.view = { ...this.view, turn, question };
    if (this.lastConfirmed.version === this.view.version) this.lastConfirmed = this.view;
  }

  private async finish(turn: number, question: string, rawText: string, decision: RouteDecision | null, pending: Pending, late: boolean, reason?: string) {
    if (!decision) {
      const why = reason ?? (pending.error instanceof Error ? pending.error.message : 'no answer');
      this.setStatus({ routerState: 'error', message: `Claude unavailable (${why}); using instant match.` });
      this.log('router-fallback', { turn, reason: why });
      if (turn < this.latestEnded) return;
      // Keep an instant match already showing for this question; otherwise show the instant match or the flag.
      if (late && this.view.turn === turn && this.view.mode === 'confirmed') return;
      this.applyInstant(turn, question, 'offline', true);
      return;
    }
    this.setStatus({ routerState: 'ok', lastLatencyMs: decision.latencyMs, message: undefined });
    if (turn < this.latestEnded) return; // a newer question already arrived
    const checked = await this.checked(turn, question, decision);
    if (turn < this.latestEnded) return;
    if (late) await this.applyLate(turn, question, rawText, checked);
    else await this.apply(turn, question, rawText, checked);
  }

  // ---------------------------------------------------------------- guard rails on Claude's pick

  /**
   * A follow-up or conditional answer only makes sense right after its story.
   * A behavioral question ("tell me about a time…") is never answered with a
   * follow-up, a conditional, a resume line or a question to ask.
   */
  private allowed(question: string, ids: string[]): { ok: boolean; reason?: string } {
    const recent = new Set(this.shown.slice(-3));
    const behavioral = BEHAVIORAL.test(question);
    for (const id of ids) {
      const piece = this.sheet.pieces[id];
      if (!piece) continue;
      if (piece.kind === 'followup' || piece.kind === 'conditional') {
        if (!piece.parent || !recent.has(piece.parent)) {
          return { ok: false, reason: `${id} is a ${piece.kind === 'followup' ? 'follow-up to' : 'conditional answer under'} ${piece.parent ?? '?'}, which has not just been shown` };
        }
        if (behavioral) return { ok: false, reason: `${id} is a ${piece.kind} answer, but the interviewer asked a behavioral question` };
      }
      if (behavioral && (piece.kind === 'resume' || piece.kind === 'ask')) {
        return { ok: false, reason: `${id} is a ${piece.kind} item, but the interviewer asked a behavioral question` };
      }
    }
    return { ok: true };
  }

  /** Rejects an impossible pick; asks Claude once more with the reason; otherwise treats it as not in the Sheet. */
  private async checked(turn: number, question: string, d: RouteDecision): Promise<RouteDecision> {
    if (d.action !== 'show' || !d.ids.length) return d;
    const verdict = this.allowed(question, d.ids);
    if (verdict.ok) return d;
    this.log('decision-rejected', { turn, ids: d.ids, reason: verdict.reason });
    if (this.router) {
      const note = `Your previous pick (${d.ids.join(', ')}) was rejected: ${verdict.reason}. Follow-up and conditional answers are only for a short question about the story that was just shown. Choose a Question Finder entry, a story, or a Core, Classic or Tough answer that fits this question on its own, or return "not_in_sheet".`;
      const controller = new AbortController();
      const retry = await Promise.race([
        this.router.route(this.context(turn, question, note), controller.signal).catch(() => null),
        after(this.opts.routerTimeoutMs),
      ]);
      if (retry !== SLOW && retry && retry.action !== 'show') return retry;
      if (retry !== SLOW && retry && retry.action === 'show' && this.allowed(question, retry.ids).ok) return retry;
      if (retry === SLOW) controller.abort();
      if (retry && retry !== SLOW) this.log('decision-rejected', { turn, ids: retry.ids, reason: 'rejected again' });
    }
    const closest = this.matcher
      .match(question, { shown: this.shown })
      .ranked.map((r) => r.id)
      .filter((id) => this.allowed(question, [id]).ok)
      .slice(0, 2);
    return { ...d, action: 'not_in_sheet', ids: [], closest, bridge: '' };
  }

  /** Claude answered after the instant match was already showing for this question. */
  private async applyLate(turn: number, question: string, rawText: string, d: RouteDecision) {
    const v = this.view;
    const instantShowing = v.turn === turn && v.mode === 'confirmed' && v.source === 'instant';
    if (instantShowing && this.lastScrollAt > this.viewShownAt) {
      // You're already reading it: keep it, and offer Claude's pick one click away.
      const claudeFirst = d.action === 'show' && d.ids.length ? this.firstPiece(d.ids) : undefined;
      if (claudeFirst && claudeFirst !== v.blocks[0]?.piece) {
        this.setView({ ...v, runnerUp: { id: d.ids[0]!, label: pieceLabel(this.sheet, d.ids[0]!) } });
      }
      return;
    }
    if (instantShowing && d.action === 'ignore') return;
    await this.apply(turn, question, rawText, d);
  }

  private async apply(turn: number, question: string, rawText: string, d: RouteDecision) {
    this.log('decision', { turn, question, ...d });
    if (d.suggestedQuestion.trim() && /\?\s*$/.test(d.suggestedQuestion) && wordCount(d.suggestedQuestion) <= 25) {
      if (!this.tray.suggestions.includes(d.suggestedQuestion.trim())) {
        this.tray = { ...this.tray, suggestions: [d.suggestedQuestion.trim(), ...this.tray.suggestions].slice(0, 5) };
        this.emit('tray', this.tray);
      }
    }
    if (d.action === 'ignore') {
      this.outcome.set(turn, 'ignore');
      if (this.view.mode === 'provisional' && this.view.turn === turn) this.revert();
      return;
    }
    if (d.action === 'not_in_sheet' || !d.ids.length) {
      if (this.draft) this.draftPromise = this.startDraft(turn, question, d.closest, d.latencyMs);
      else this.showNotInSheet(turn, question, d.closest, 'claude', d.latencyMs);
      return;
    }
    // You already started reading the early guess for this question: keep it, offer Claude's pick as the runner-up.
    if (this.view.mode === 'provisional' && this.view.turn === turn && this.lastScrollAt > this.viewShownAt) {
      const claudeFirst = this.firstPiece(d.ids);
      const current = this.view.blocks[0]?.piece;
      this.outcome.set(turn, 'show');
      this.setView({
        ...this.view,
        mode: 'confirmed',
        source: 'instant',
        ...(claudeFirst && claudeFirst !== current ? { runnerUp: { id: d.ids[0]!, label: pieceLabel(this.sheet, d.ids[0]!) } } : {}),
      });
      return;
    }
    let ids = d.ids;
    if (['confirmed', 'drafted'].includes(this.view.mode)) {
      const onScreen = new Set(this.view.pieces);
      const fresh = ids.filter((id) => !expandIds(this.sheet, [id]).every((p) => onScreen.has(p.piece)));
      if (fresh.length && fresh.length < ids.length) {
        // Claude repeated what is already on screen along with something new: show the new part.
        ids = fresh;
      } else if (!fresh.length && !this.isolated.has(turn) && Date.now() - this.viewShownAt < 20000) {
        // The exact same answer again, seconds later (a rephrase or a trailing piece): keep the script and your place.
        this.outcome.set(turn, 'show');
        this.adoptTurn(turn, question);
        this.log('same-script', { turn, pieces: this.view.pieces });
        return;
      }
      // Otherwise it is a new question that happens to get the same answer: show it again from the top.
    }
    const plain = displayText(this.sheet, ids);
    const bridge = d.bridge && ids === d.ids ? validateBridge(d.bridge, question, plain) : null;
    if (d.bridge && ids === d.ids && !bridge) this.log('bridge-rejected', { bridge: d.bridge });
    this.showIds(ids, {
      source: 'claude',
      question,
      turn,
      bridge: bridge ?? undefined,
      latencyMs: d.latencyMs,
      runnerUp: d.runnerUp ? { id: d.runnerUp, label: pieceLabel(this.sheet, d.runnerUp) } : undefined,
    });
  }

  private applyInstant(turn: number, question: string, source: 'instant' | 'offline', flagIfNoMatch: boolean) {
    const m: MatchResult = this.matcher.match(question, { shown: this.shown });
    this.log('instant', { turn, question, ranked: m.ranked.slice(0, 3) });
    if (m.score >= this.opts.offlineMin && m.ids.length && this.allowed(question, m.ids).ok) {
      this.showIds(m.ids, {
        source,
        question,
        turn,
        confidence: m.score,
        runnerUp: m.runnerUp ? { id: m.runnerUp, label: pieceLabel(this.sheet, m.runnerUp) } : undefined,
      });
      return;
    }
    if (!flagIfNoMatch) return; // still waiting for Claude
    const isQuestion = /\?\s*$/.test(question) || BEHAVIORAL.test(question) || DIRECT.test(question.trim());
    if (!isQuestion) {
      if (this.view.mode === 'provisional' && this.view.turn === turn) this.revert();
      return;
    }
    const closest = m.ranked.map((r) => r.id).filter((id) => this.allowed(question, [id]).ok).slice(0, 2);
    this.showNotInSheet(turn, question, closest, source);
  }

  private showIds(
    ids: string[],
    o: {
      source: BannerSource;
      question: string;
      turn: number;
      bridge?: string;
      latencyMs?: number;
      confidence?: number;
      runnerUp?: { id: string; label: string };
    },
  ) {
    const script = this.render(ids, o.bridge);
    if (!script) return;
    for (const id of script.pieces) if (!this.shown.includes(id)) this.shown.push(id);
    this.outcome.set(o.turn, 'show');
    this.setView({
      mode: 'confirmed',
      source: o.source,
      label: script.label,
      cues: script.cues,
      blocks: script.blocks,
      closest: [],
      unmetBackrefs: this.unmet(script, true),
      pieces: script.pieces,
      ...(o.runnerUp ? { runnerUp: o.runnerUp } : {}),
      ...(o.confidence !== undefined ? { confidence: o.confidence } : {}),
      ...(o.latencyMs !== undefined ? { latencyMs: o.latencyMs } : {}),
      question: o.question,
      turn: o.turn,
    });
  }

  // ---------------------------------------------------------------- drafted answers

  private plainText(id: string, max: number): string {
    try {
      const t = displayText(this.sheet, [id]).replace(/\s+/g, ' ').trim();
      return t.length > max ? `${t.slice(0, max)}…` : t;
    } catch {
      return '';
    }
  }

  private draftBlocks(text: string, spans?: { text: string; unverified: boolean }[]): ScriptBlock[] {
    const chunks = (spans ?? [{ text, unverified: false }]).map((sp) => ({
      text: sp.text,
      kind: 'draft' as const,
      bold: false,
      italic: false,
      ...(sp.unverified ? { unverified: true } : {}),
    }));
    return [{ piece: 'draft', chunks }];
  }

  /** The Sheet has no answer: stream a drafted one, with the closest Sheet material one click away. */
  private async startDraft(turn: number, question: string, closestIds: string[], latencyMs?: number) {
    const support = this.draft!;
    this.draftController?.abort();
    const controller = new AbortController();
    this.draftController = controller;
    const closestId = closestIds.find((id) => this.sheet.pieces[id]);
    const runnerUp = closestId ? { id: closestId, label: pieceLabel(this.sheet, closestId) } : undefined;
    const base = {
      mode: 'drafted' as const,
      source: 'claude' as const,
      label: 'Drafted',
      cues: ['Not from your Sheet. Drafted from your materials; dotted words are not in them.'],
      closest: [],
      unmetBackrefs: [],
      pieces: ['draft'],
      ...(runnerUp ? { runnerUp } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      question,
      turn,
    };
    this.outcome.set(turn, 'drafted');
    this.setView({ ...base, blocks: [], drafting: true });
    this.log('draft-start', { turn, question, closest: closestIds });

    let lastPush = 0;
    let latest = '';
    let timer: NodeJS.Timeout | undefined;
    const push = () => {
      if (controller.signal.aborted || this.view.turn !== turn || this.view.mode !== 'drafted') return;
      lastPush = Date.now();
      this.setView({ ...base, blocks: this.draftBlocks(latest), drafting: true });
    };
    const req = {
      question,
      recent: this.context(turn, question).recent,
      said: this.shown.slice(-8).map((id) => this.plainText(id, 400)).filter(Boolean),
      closest: closestIds.slice(0, 2).map((id) => ({ label: pieceLabel(this.sheet, id), text: this.plainText(id, 600) })).filter((c) => c.text),
    };
    try {
      const final = await support.drafter.draft(
        req,
        (textSoFar) => {
          latest = textSoFar;
          const wait = DRAFT_UPDATE_MS - (Date.now() - lastPush);
          if (wait <= 0) push();
          else if (!timer) timer = setTimeout(() => ((timer = undefined), push()), wait);
        },
        controller.signal,
      );
      if (timer) clearTimeout(timer);
      if (controller.signal.aborted || this.view.turn !== turn) return;
      const known = [support.knownText, question, ...req.recent, ...req.said].join('\n');
      const spans = checkClaims(final, known);
      this.setView({ ...base, blocks: this.draftBlocks(final, spans), drafting: false });
      this.log('draft-done', { turn, words: wordCount(final), unverified: spans.filter((x) => x.unverified).map((x) => x.text) });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (controller.signal.aborted || this.view.turn !== turn) return;
      this.log('draft-failed', { turn, error: String((e as Error).message ?? e) });
      this.setStatus({ message: `Couldn't draft an answer (${(e as Error).message ?? e}); showing the closest Sheet material.` });
      this.showNotInSheet(turn, question, closestIds, 'claude', latencyMs);
    } finally {
      if (this.draftController === controller) this.draftController = undefined;
    }
  }

  private showNotInSheet(turn: number, question: string, closestIds: string[], source: BannerSource, latencyMs?: number) {
    const closest = closestIds
      .map((id) => {
        const s = this.render([id]);
        return s ? { id, label: s.label, blocks: s.blocks } : null;
      })
      .filter((x): x is { id: string; label: string; blocks: ScriptBlock[] } => !!x);
    this.outcome.set(turn, 'none');
    this.setView({
      mode: 'not-in-sheet',
      source,
      label: 'Not in Sheet',
      cues: [],
      blocks: [],
      closest,
      unmetBackrefs: [],
      pieces: [],
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      question,
      turn,
    });
  }

  /** Back to the last confirmed script, same version, so the banner restores your scroll position. */
  private revert() {
    this.view = this.lastConfirmed;
    this.emit('banner', this.view);
  }

  private render(ids: string[], bridge?: string): Script | null {
    try {
      const parts = expandIds(this.sheet, ids);
      if (!parts.length) return null;
      return renderPlan(this.sheet, parts, bridge ? { bridge } : {});
    } catch (e) {
      // VerbatimError: never display text that doesn't match the Sheet.
      this.log('render-refused', { ids, error: String(e) });
      return null;
    }
  }

  private unmet(script: Script, includeSelf: boolean): string[] {
    const shownNow = new Set([...this.shown, ...(includeSelf ? script.pieces : [])]);
    const targets = new Set<string>();
    for (const b of script.blocks) for (const c of b.chunks) if (c.backref && !shownNow.has(c.backref)) targets.add(c.backref);
    return [...targets];
  }
}
