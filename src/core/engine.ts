// The live session: turns transcript events into what the banner shows.
//
// - While the interviewer talks, the instant matcher shows a dimmed early guess.
// - When they finish, Claude's pick (piece ids only) is rendered from the Sheet
//   and locks in. If Claude is slow or unreachable, the instant match is used.
// - Once you scroll a script, nothing replaces it until the next question.

import { EventEmitter } from 'node:events';
import { validateBridge } from './bridge';
import { displayText } from './catalog';
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

export type BannerMode = 'idle' | 'provisional' | 'confirmed' | 'not-in-sheet';
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
  question: string;
  turn: number;
  version: number;
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
  /** Give up waiting for Claude after this long and use the instant match. */
  routerTimeoutMs: number;
  /** Don't swap in an early guess within this long after you scrolled. */
  scrollQuietMs: number;
}

const DEFAULTS: EngineOptions = { provisionalMin: 0.4, offlineMin: 0.45, routerTimeoutMs: 3500, scrollQuietMs: 4000 };

interface Pending {
  text: string;
  controller: AbortController;
  promise: Promise<RouteDecision | null>;
  error?: unknown;
}

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

  constructor(
    private sheet: Sheet,
    private matcher: Matcher,
    private router: Router | null,
    opts: Partial<EngineOptions> = {},
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
    if (v.mode === 'confirmed' || v.mode === 'not-in-sheet') this.lastConfirmed = this.view;
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
    let decision: RouteDecision | null = null;
    if (pending) {
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), this.opts.routerTimeoutMs));
      decision = await Promise.race([pending.promise, timeout]);
      if (!decision) {
        pending.controller.abort();
        const reason = pending.error instanceof Error ? pending.error.message : 'timed out';
        this.setStatus({ routerState: 'error', message: `Claude unavailable (${reason}); using instant match.` });
        this.log('router-fallback', { turn, reason });
      } else {
        this.setStatus({ routerState: 'ok', lastLatencyMs: decision.latencyMs, message: undefined });
      }
      this.pending.delete(turn);
    }
    if (turn < this.latestEnded) return; // a newer question already arrived
    if (decision) this.apply(turn, text, decision);
    else this.applyInstant(turn, text, this.router ? 'offline' : 'instant');
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
      this.showNotInSheet(turn, question, d.closest, 'claude', d.latencyMs);
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

  private applyInstant(turn: number, question: string, source: 'instant' | 'offline') {
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
