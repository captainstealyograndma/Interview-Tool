// The live session: turns transcript events into what the banner shows.
//
// - While the interviewer talks, the instant matcher shows a dimmed early guess.
// - When they finish, Claude's pick (piece ids only) is rendered from the Sheet
//   and locks in. If Claude is slow or unreachable, the instant match is used.
// - Once you scroll a script, nothing replaces it until the next question.
// - When the Sheet has no answer and a drafter is available, a drafted answer
//   streams in, styled apart, with unverified personal claims marked.

import { EventEmitter } from 'node:events';
import { validateBridge } from './bridge';
import { displayText } from './catalog';
import { checkClaims, type Drafter } from './drafter';
import type { Matcher, MatchResult } from './matcher';
import type { RouteDecision, Router } from './router';
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
}

const DEFAULTS: EngineOptions = { provisionalMin: 0.4, offlineMin: 0.45, routerTimeoutMs: 3500, routerGiveUpMs: 15000, scrollQuietMs: 4000 };

const SLOW = Symbol('slow');
const after = (ms: number) => new Promise<typeof SLOW>((r) => setTimeout(() => r(SLOW), ms));

interface Pending {
  text: string;
  controller: AbortController;
  promise: Promise<RouteDecision | null>;
  error?: unknown;
}

const DRAFT_UPDATE_MS = 90;

export class Engine extends EventEmitter {
  private opts: EngineOptions;
  private view: BannerView;
  private lastConfirmed: BannerView;
  private tray: TrayView;
  private status: StatusView;
  private shown: string[] = [];
  private turns: string[] = [];
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
    return { mode: 'idle', source: 'instant', label: '', cues: [], blocks: [], closest: [], unmetBackrefs: [], question: '', turn: -1, version: 0 };
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

  /** Test mode: treat typed text as a complete interviewer turn. */
  async simulate(text: string): Promise<void> {
    const turn = Math.max(this.latestEnded, this.view.turn) + 1;
    this.handle({ type: 'start', turn, text });
    await this.onFinal(turn, text);
    await this.draftPromise;
  }

  // ---------------------------------------------------------------- partials

  private onPartial(turn: number, text: string) {
    if (wordCount(text) < 5 || isBackchannel(text)) return;
    // Comments ("That's a great example") never cover the script you're reading; only questions do.
    if (!looksLikeQuestion(text)) return;
    if (this.view.turn === turn && this.view.mode !== 'provisional') return; // already confirmed this turn
    if (Date.now() - this.lastScrollAt < this.opts.scrollQuietMs) return; // you're reading
    const m = this.matcher.match(text, { shown: this.shown });
    if (m.score < this.opts.provisionalMin || !m.ids.length) return;
    if (this.view.mode === 'provisional' && this.view.turn === turn && this.view.blocks[0]?.piece === this.firstPiece(m.ids)) return;
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
      ...(m.runnerUp ? { runnerUp: { id: m.runnerUp, label: pieceLabel(this.sheet, m.runnerUp) } } : {}),
      confidence: m.score,
      question: text,
      turn,
    });
  }

  private firstPiece(ids: string[]): string | undefined {
    const parts = expandIds(this.sheet, ids);
    return parts[0]?.piece;
  }

  // ---------------------------------------------------------------- routing

  private context(question: string) {
    return {
      question,
      recent: this.turns.slice(-6),
      shown: this.shown.slice(-10).map((id) => ({ id, label: pieceLabel(this.sheet, id) })),
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
      promise: this.router.route(this.context(text), controller.signal).catch((e) => {
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
      this.turns.push(text);
      if (this.view.mode === 'provisional' && this.view.turn === turn) this.revert();
      return;
    }
    const pending = this.startRoute(turn, text);
    this.turns.push(text);
    if (!pending) {
      if (turn < this.latestEnded) return; // a newer question already arrived
      this.applyInstant(turn, text, 'instant', true);
      return;
    }
    const first = await Promise.race([pending.promise, after(this.opts.routerTimeoutMs)]);
    if (first !== SLOW) {
      this.pending.delete(turn);
      this.finish(turn, text, first, pending, false);
      return;
    }
    // Claude is slow. Show a confident instant match meanwhile (never a "Not in Sheet" flag),
    // and keep waiting: Claude's answer is never thrown away just for being slow.
    this.setStatus({ routerState: 'ok', message: 'Claude is taking a little longer; the banner updates when it answers.' });
    this.log('router-slow', { turn });
    if (turn >= this.latestEnded) this.applyInstant(turn, text, 'instant', false);
    const late = await Promise.race([pending.promise, after(Math.max(0, this.opts.routerGiveUpMs - this.opts.routerTimeoutMs))]);
    this.pending.delete(turn);
    if (late === SLOW) {
      pending.controller.abort();
      this.finish(turn, text, null, pending, true, 'no answer after 15 seconds');
      return;
    }
    this.finish(turn, text, late, pending, true);
  }

  private finish(turn: number, text: string, decision: RouteDecision | null, pending: Pending, late: boolean, reason?: string) {
    if (!decision) {
      const why = reason ?? (pending.error instanceof Error ? pending.error.message : 'no answer');
      this.setStatus({ routerState: 'error', message: `Claude unavailable (${why}); using instant match.` });
      this.log('router-fallback', { turn, reason: why });
      if (turn < this.latestEnded) return;
      // Keep an instant match already showing for this question; otherwise show the instant match or the flag.
      if (late && this.view.turn === turn && this.view.mode === 'confirmed') return;
      this.applyInstant(turn, text, 'offline', true);
      return;
    }
    this.setStatus({ routerState: 'ok', lastLatencyMs: decision.latencyMs, message: undefined });
    if (turn < this.latestEnded) return; // a newer question already arrived
    if (late) this.applyLate(turn, text, decision);
    else this.apply(turn, text, decision);
  }

  /** Claude answered after the instant match was already showing for this question. */
  private applyLate(turn: number, question: string, d: RouteDecision) {
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
    this.apply(turn, question, d);
  }

  private apply(turn: number, question: string, d: RouteDecision) {
    this.log('decision', { turn, question, ...d });
    if (d.suggestedQuestion.trim() && /\?\s*$/.test(d.suggestedQuestion) && wordCount(d.suggestedQuestion) <= 25) {
      if (!this.tray.suggestions.includes(d.suggestedQuestion.trim())) {
        this.tray = { ...this.tray, suggestions: [d.suggestedQuestion.trim(), ...this.tray.suggestions].slice(0, 5) };
        this.emit('tray', this.tray);
      }
    }
    if (d.action === 'ignore') {
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
      this.setView({
        ...this.view,
        mode: 'confirmed',
        source: 'instant',
        ...(claudeFirst && claudeFirst !== current ? { runnerUp: { id: d.ids[0]!, label: pieceLabel(this.sheet, d.ids[0]!) } } : {}),
      });
      return;
    }
    const plain = displayText(this.sheet, d.ids);
    const bridge = d.bridge ? validateBridge(d.bridge, question, plain) : null;
    if (d.bridge && !bridge) this.log('bridge-rejected', { bridge: d.bridge });
    this.showIds(d.ids, {
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
    if (m.score >= this.opts.offlineMin && m.ids.length) {
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
    const looksLikeQuestion = /\?\s*$/.test(question) || BEHAVIORAL.test(question) || DIRECT.test(question.trim());
    if (!looksLikeQuestion) {
      if (this.view.mode === 'provisional' && this.view.turn === turn) this.revert();
      return;
    }
    this.showNotInSheet(turn, question, m.ranked.slice(0, 2).map((r) => r.id), source);
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
    this.setView({
      mode: 'confirmed',
      source: o.source,
      label: script.label,
      cues: script.cues,
      blocks: script.blocks,
      closest: [],
      unmetBackrefs: this.unmet(script, true),
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
      ...(runnerUp ? { runnerUp } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      question,
      turn,
    };
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
      recent: this.turns.slice(-7, -1),
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
    this.setView({
      mode: 'not-in-sheet',
      source,
      label: 'Not in Sheet',
      cues: [],
      blocks: [],
      closest,
      unmetBackrefs: [],
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
