import { describe, expect, it } from 'vitest';
import { validateBridge } from '../src/core/bridge';
import { renderCatalog } from '../src/core/catalog';
import { Engine, type BannerView } from '../src/core/engine';
import { Matcher } from '../src/core/matcher';
import { requestText, type RouteDecision, type RouteRequest, type Router } from '../src/core/router';
import { scriptText } from '../src/core/script';
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
  constructor(private answer: (req: RouteRequest) => RouteDecision | Promise<RouteDecision>) {}
  async route(req: RouteRequest) {
    this.calls.push(req);
    return this.answer(req);
  }
  async warm() {}
}

const bannerText = (v: BannerView) => v.blocks.map((b) => b.chunks.map((c) => c.text).join('')).join('\n');

describe('Instant matcher', () => {
  const cases: [string, string, string[]?][] = [
    ['Tell me about a time you solved a hard problem.', 'Q1'],
    ["What's your greatest weakness?", 'K1'],
    ['So why consulting?', 'C2'],
    ['Could you start by telling me about yourself?', 'C1'],
    ['Who noticed first?', 'S1.F1', ['S1']],
    ['Tell me about your grades.', 'T1'],
    ['How strong are your Excel skills?', 'T2'],
    ['I see you built inventory reports at Acme Retail.', 'R3'],
    ['Give me an example of working on a team.', 'Q5'],
  ];
  for (const [q, want, shown] of cases) {
    it(`"${q}" -> ${want}`, async () => {
      const { sheet } = await fixtureSheet();
      const m = new Matcher(sheet).match(q, { shown: shown ?? [] });
      expect(m.ids[0]).toBe(want);
    });
  }

  it('recognizes "any questions for me" as the questions-to-ask list', async () => {
    const { sheet } = await fixtureSheet();
    expect(new Matcher(sheet).match('Do you have any questions for me?').ids).toEqual(['A1', 'A2', 'A3']);
  });

  it('uses load-time phrasings when given', async () => {
    const { sheet } = await fixtureSheet();
    const plain = new Matcher(sheet).match('Talk about a crunch you were under');
    const tuned = new Matcher(sheet, { Q2: ['Talk about a crunch you were under'] }).match('Talk about a crunch you were under');
    expect(tuned.ids[0]).toBe('Q2');
    expect(tuned.score).toBeGreaterThan(plain.score);
  });
});

describe('Bridge validation', () => {
  const script = 'Situation: At Acme Retail I worked on the warehouse project.';
  it('keeps a lead-in made of question words, script words and connectors', () => {
    expect(validateBridge('One example comes from the warehouse project.', 'Tell me about a time you used data.', script)).toBe(
      'One example comes from the warehouse project.',
    );
  });
  it('drops a lead-in that adds a fact', () => {
    expect(validateBridge('At Google I led a huge data team.', 'Tell me about data.', script)).toBeNull();
    expect(validateBridge('I saved 40 percent.', 'Tell me about savings.', script)).toBeNull();
  });
  it('drops a lead-in that is too long', () => {
    expect(validateBridge('one '.repeat(16), 'q', script)).toBeNull();
  });
});

describe('Catalog for Claude', () => {
  it('lists every piece id and the Question Finder pairings', async () => {
    const { sheet } = await fixtureSheet();
    const catalog = renderCatalog(sheet);
    for (const id of sheet.order) expect(catalog).toContain(`[${id}]`);
    expect(catalog).toContain('opening line: "I once had a week to find forty volunteers."');
    expect(catalog).toContain('shows: its opening line + Story 3 · The volunteer drive (paragraphs 3, 4 only)');
  });
  it('sends only context and the question per request', () => {
    const text = requestText({ question: 'Who won?', recent: ['Tell me about a trial.'], shown: [{ id: 'S1', label: 'Story 1' }] });
    expect(text).toContain('The interviewer just said: "Who won?"');
    expect(text).toContain('S1 (Story 1)');
  });
});

describe('Session engine', () => {
  it('shows Claude\'s pick, rendered word for word from the Sheet', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter(() => decision({ ids: ['Q1'], runnerUp: 'S3' }));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    await engine.simulate('Tell me about a time you solved a hard problem.');
    const v = engine.banner;
    expect(v.mode).toBe('confirmed');
    expect(v.source).toBe('claude');
    expect(bannerText(v).split('\n')[0]).toBe('Last year I found a gap in our inventory counts.');
    expect(bannerText(v)).toContain('Then I compared the counts against the invoices, one week at a time.');
    expect(v.cues).toContain('Then tell Story 1, and focus on the invoices.');
    expect(v.runnerUp?.id).toBe('S3');
    expect(engine.shownPieces).toEqual(['Q1', 'S1']);
  });

  it('passes recent turns and shown pieces to the router for follow-ups', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter((req) => decision({ ids: req.question.startsWith('Who') ? ['S1.F1'] : ['Q1'] }));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    await engine.simulate('Tell me about a time you solved a hard problem.');
    await engine.simulate('Who noticed first?');
    expect(router.calls[1]!.shown.map((s) => s.id)).toEqual(['Q1', 'S1']);
    expect(router.calls[1]!.recent).toEqual(['Tell me about a time you solved a hard problem.']);
    expect(bannerText(engine.banner)).toBe('I did. Then I told my manager the same day.');
  });

  it('flags questions the Sheet does not cover and shows the closest material', async () => {
    const { sheet } = await fixtureSheet();
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter(() => decision({ action: 'not_in_sheet', closest: ['K2'] })));
    await engine.simulate('What is your favorite movie?');
    expect(engine.banner.mode).toBe('not-in-sheet');
    expect(engine.banner.label).toBe('Not in Sheet');
    expect(engine.banner.closest.map((c) => c.id)).toEqual(['K2']);
  });

  it('ignores small talk and acknowledgements without calling Claude', async () => {
    const { sheet } = await fixtureSheet();
    const router = new FakeRouter(() => decision({ action: 'ignore' }));
    const engine = new Engine(sheet, new Matcher(sheet), router);
    await engine.simulate('Great.');
    expect(router.calls).toHaveLength(0);
    await engine.simulate("I've been at the firm about six years and I love the people here.");
    expect(engine.banner.mode).toBe('idle');
  });

  it('keeps a valid lead-in, styled separately, and drops one that adds facts', async () => {
    const { sheet } = await fixtureSheet();
    let bridge = 'One example comes from the warehouse project.';
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter(() => decision({ ids: ['S1'], bridge })));
    await engine.simulate('Tell me about a time you used data to find something.');
    expect(engine.banner.blocks[0]!.chunks[0]).toMatchObject({ kind: 'bridge', text: bridge });
    bridge = 'At Google I found a 40% gap.';
    await engine.simulate('Tell me about another time you used data.');
    expect(engine.banner.blocks[0]!.chunks[0]!.kind).not.toBe('bridge');
  });

  it('falls back to the instant match when Claude is unavailable', async () => {
    const { sheet } = await fixtureSheet();
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter(() => Promise.reject(new Error('network down'))));
    await engine.simulate("What's your greatest weakness?");
    expect(engine.banner.source).toBe('offline');
    expect(engine.banner.blocks[0]!.piece).toBe('K1');
    expect(engine.statusView.routerState).toBe('error');
  });

  it('falls back when Claude is too slow', async () => {
    const { sheet } = await fixtureSheet();
    const slow = new FakeRouter(() => new Promise((r) => setTimeout(() => r(decision({ ids: ['K2'] })), 500)));
    const engine = new Engine(sheet, new Matcher(sheet), slow, { routerTimeoutMs: 50 });
    await engine.simulate("What's your greatest weakness?");
    expect(engine.banner.blocks[0]!.piece).toBe('K1');
  });

  it('shows a dimmed early guess while the interviewer is talking, then confirms', async () => {
    const { sheet } = await fixtureSheet();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter(async () => (await gate, decision({ ids: ['K1'] }))));
    engine.handle({ type: 'update', turn: 0, text: "So what's your greatest weakness" });
    expect(engine.banner.mode).toBe('provisional');
    expect(engine.banner.blocks[0]!.piece).toBe('K1');
    engine.handle({ type: 'end', turn: 0, text: "So what's your greatest weakness?" });
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.banner.mode).toBe('confirmed');
  });

  it('never switches the text after you start scrolling it', async () => {
    const { sheet } = await fixtureSheet();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter(async () => (await gate, decision({ ids: ['T1'] }))));
    engine.handle({ type: 'update', turn: 0, text: "So what's your greatest weakness" });
    await new Promise((r) => setTimeout(r, 5));
    engine.userScrolled();
    engine.handle({ type: 'end', turn: 0, text: "So what's your greatest weakness?" });
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.banner.blocks[0]!.piece).toBe('K1');
    expect(engine.banner.runnerUp?.id).toBe('T1');
    engine.showRunnerUp();
    expect(engine.banner.blocks[0]!.piece).toBe('T1');
  });

  it('underlines a back-reference until its story has been shown', async () => {
    const { sheet } = await fixtureSheet();
    const ids: Record<string, string[]> = { excel: ['T2'], problem: ['S1'] };
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter((r) => decision({ ids: r.question.includes('Excel') ? ids.excel! : ids.problem! })));
    await engine.simulate('How strong are your Excel skills?');
    expect(engine.banner.unmetBackrefs).toEqual(['S1']);
    await engine.simulate('Tell me about a problem you solved.');
    await engine.simulate('How strong are your Excel skills, again?');
    expect(engine.banner.unmetBackrefs).toEqual([]);
  });

  it('adds suggested questions to the tray, keeping the Sheet questions', async () => {
    const { sheet } = await fixtureSheet();
    const engine = new Engine(
      sheet,
      new Matcher(sheet),
      new FakeRouter(() => decision({ action: 'ignore', suggestedQuestion: 'How is the new retail team structured?' })),
    );
    await engine.simulate("We just started a new retail team that I'm building out this year.");
    expect(engine.trayView.suggestions).toEqual(['How is the new retail team structured?']);
    expect(engine.trayView.sheetQuestions.map((q) => q.id)).toEqual(['A1', 'A2', 'A3']);
    expect(engine.trayView.sheetQuestions[2]!.note).toBe('To close');
  });

  it('expands a resume line that only points elsewhere', async () => {
    const { sheet } = await fixtureSheet();
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter(() => decision({ ids: ['R2'] })));
    await engine.simulate('I see a 3.4 GPA on your resume.');
    expect(scriptText({ label: '', cues: [], pieces: [], blocks: engine.banner.blocks })).toBe('They went up every year, and I took the 401(k) seminar for fun.');
  });
});
