// Questions that arrive in pieces, and guard rails on Claude's picks.
import { describe, expect, it } from 'vitest';
import { Engine, type BannerView } from '../src/core/engine';
import { Matcher } from '../src/core/matcher';
import type { RouteDecision, RouteRequest, Router } from '../src/core/router';
import { fixtureSheet } from './helpers';

const decision = (d: Partial<RouteDecision>): RouteDecision => ({
  action: 'show',
  ids: [],
  closest: [],
  runnerUp: '',
  bridge: '',
  suggestedQuestion: '',
  latencyMs: 5,
  model: 'fake',
  ...d,
});

class FakeRouter implements Router {
  calls: RouteRequest[] = [];
  constructor(private answer: (req: RouteRequest, n: number) => RouteDecision) {}
  async route(req: RouteRequest) {
    this.calls.push(req);
    return this.answer(req, this.calls.length);
  }
  async warm() {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bannerText = (v: BannerView) => v.blocks.map((b) => b.chunks.map((c) => c.text).join('')).join('');

/** Feeds a turn the way the transcriber does: start, then end; returns when the engine has settled. */
async function speak(engine: Engine, turn: number, text: string) {
  engine.handle({ type: 'start', turn, text: text.split(' ').slice(0, 3).join(' ') });
  engine.handle({ type: 'end', turn, text });
  await sleep(40);
}

const PREAMBLE = "That's really helpful context. Thank you! So let me ask a follow-up then.";
const QUESTION = 'Tell me about a time when you had to get up to speed quickly on something really unfamiliar or complex. What was the situation? And how did you handle it?';

describe('Questions that arrive in pieces', () => {
  it('joins a preamble turn with the question that follows it', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter((req) => (/Tell me about a time/.test(req.question) ? decision({ ids: ['Q1'] }) : decision({ action: 'ignore' })));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    await speak(engine, 0, PREAMBLE);
    expect(engine.banner.mode).toBe('idle');
    await speak(engine, 1, QUESTION);
    // Claude saw the whole thing as one question, with the preamble inside it rather than as "earlier turns".
    expect(router.calls[1]!.question).toBe(`${PREAMBLE} ${QUESTION}`);
    expect(router.calls[1]!.recent).toEqual([]);
    expect(engine.banner.mode).toBe('confirmed');
    expect(engine.banner.blocks[0]!.piece).toBe('Q1');
  });

  it('a trailing fragment ("what was the situation? and how did you handle it?") keeps the answer already showing', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter(() => decision({ ids: ['Q1'] }));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    await speak(engine, 0, 'Tell me about a time you solved a hard problem.');
    const shown = engine.banner;
    await speak(engine, 1, 'What was the situation? And how did you handle it?');
    expect(router.calls).toHaveLength(1); // not asked again
    expect(engine.banner.version).toBe(shown.version); // same script, same scroll position
    expect(engine.banner.turn).toBe(1);
  });

  it('when Claude returns the same script for a later piece, the banner keeps its place', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter(() => decision({ ids: ['Q1'] }));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    await speak(engine, 0, 'Tell me about a time you solved a hard problem.');
    const shown = engine.banner;
    await speak(engine, 1, 'I mean a problem where the data did not add up and you had to dig into why.');
    expect(router.calls).toHaveLength(2);
    expect(engine.banner.version).toBe(shown.version);
  });

  it('turns separated by a real pause are separate questions', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter((req) => (/weakness/.test(req.question) ? decision({ ids: ['K1'] }) : decision({ ids: ['T1'] })));
    const engine = new Engine(sheet, new Matcher(sheet), router, { clusterGapMs: 30 });
    await speak(engine, 0, "What's your greatest weakness?");
    await sleep(60);
    await speak(engine, 1, 'Tell me about your grades.');
    expect(router.calls[1]!.question).toBe('Tell me about your grades.');
    expect(router.calls[1]!.recent).toEqual(["What's your greatest weakness?"]);
    expect(engine.banner.blocks[0]!.piece).toBe('T1');
  });

  it('typed test questions are always separate', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter((req) => decision({ ids: [/weakness/.test(req.question) ? 'K1' : 'T1'] }));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    await engine.simulate("What's your greatest weakness?");
    await engine.simulate('Tell me about your grades.');
    expect(router.calls[1]!.question).toBe('Tell me about your grades.');
  });
});

describe('Guard rails on picks', () => {
  it("refuses a follow-up answer for a story that hasn't been shown, asks Claude again, and shows the corrected pick", async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter((req) => (req.note ? decision({ ids: ['Q1'] }) : decision({ ids: ['S1.F2'] })));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    const log: string[] = [];
    engine.on('log', (e: { msg: string }) => log.push(e.msg));
    await engine.simulate(QUESTION);
    expect(log).toContain('decision-rejected');
    expect(router.calls[1]!.note).toMatch(/S1\.F2/);
    expect(engine.banner.blocks[0]!.piece).toBe('Q1');
    expect(bannerText(engine.banner)).not.toContain('Ask for the invoices sooner');
  });

  it('a follow-up is fine right after its story', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter((req) => (/differently/.test(req.question) ? decision({ ids: ['S1.F2'] }) : decision({ ids: ['Q1'] })));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    await engine.simulate('Tell me about a time you solved a hard problem.');
    await engine.simulate('What would you do differently?');
    expect(engine.banner.blocks[0]!.piece).toBe('S1.F2');
    expect(router.calls).toHaveLength(2);
  });

  it('a behavioral question never gets a follow-up even if its story was just shown', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter((req) => (req.note ? decision({ action: 'not_in_sheet', closest: ['S1'] }) : decision({ ids: [/hard problem/.test(req.question) ? 'Q1' : 'S1.F2'] })));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    await engine.simulate('Tell me about a time you solved a hard problem.');
    await engine.simulate(QUESTION);
    expect(engine.banner.mode).toBe('not-in-sheet');
    expect(engine.banner.closest[0]!.id).toBe('S1');
  });

  it('a behavioral question never gets a resume line; a second bad pick falls back to Not in Sheet with closest material', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter(() => decision({ ids: ['R3'] }));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    await engine.simulate(QUESTION);
    expect(router.calls).toHaveLength(2);
    expect(engine.banner.mode).toBe('not-in-sheet');
    for (const c of engine.banner.closest) expect(['followup', 'conditional', 'resume', 'ask']).not.toContain(sheet.pieces[c.id]!.kind);
  });

  it('the on-device fallback obeys the same rules', async () => {
    const { sheet } = await fixtureSheet();
    const engine = new Engine(sheet, new Matcher(sheet), null);
    await engine.simulate('Tell me about a time you asked for the invoices sooner and what you would do differently.');
    const first = engine.banner.blocks[0]?.piece;
    if (first) expect(['followup', 'conditional']).not.toContain(sheet.pieces[first]!.kind);
  });
});
