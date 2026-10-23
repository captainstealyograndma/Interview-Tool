import { describe, expect, it } from 'vitest';
import { checkClaims, DRAFTER_INSTRUCTIONS, type Drafter, type DraftRequest } from '../src/core/drafter';
import { Engine, type BannerView } from '../src/core/engine';
import { Matcher } from '../src/core/matcher';
import type { RouteDecision, RouteRequest, Router } from '../src/core/router';
import { fixtureSheet } from './helpers';

const MATERIALS = `=== RESUME ===
Jordan Example. State University, B.A. in Economics, 2024. GPA 3.40.
Acme Retail, Analyst Intern, Summer 2023. Built the weekly inventory report in Excel and SQL.`;

describe('Claim check on drafted answers', () => {
  it('leaves known facts and plain prose alone', () => {
    const spans = checkClaims('At Acme Retail I built the weekly inventory report in Excel. That taught me to start with the data I trust.', MATERIALS);
    expect(spans.every((s) => !s.unverified)).toBe(true);
  });

  it('marks names, employers and numbers that are not in the materials', () => {
    const draft = 'At Acme Retail I built reports, and at Globex Corporation I led a team of 12 people in Denver.';
    const spans = checkClaims(draft, MATERIALS);
    expect(spans.filter((s) => s.unverified).map((s) => s.text)).toEqual(['Globex Corporation', '12', 'Denver']);
    expect(spans.map((s) => s.text).join('')).toBe(draft);
  });

  it('does not flag subject-matter references or years that appear in the materials', () => {
    const spans = checkClaims('Section 351 lets you contribute property tax-free, and in 2023 I saw that at Acme Retail. Rule 35 is different.', MATERIALS);
    expect(spans.filter((s) => s.unverified)).toEqual([]);
  });

  it('allows facts that came up earlier in the interview', () => {
    const known = `${MATERIALS}\nThe interviewer just asked about the Springfield office.`;
    const spans = checkClaims('The Springfield office sounds like a good fit.', known);
    expect(spans.filter((s) => s.unverified)).toEqual([]);
  });

  it('the drafter instructions forbid invented personal facts', () => {
    expect(DRAFTER_INSTRUCTIONS).toMatch(/Never invent/);
    expect(DRAFTER_INSTRUCTIONS).toMatch(/Never contradict/);
  });
});

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
  constructor(private answer: (req: RouteRequest) => RouteDecision) {}
  async route(req: RouteRequest) {
    return this.answer(req);
  }
  async warm() {}
}

class FakeDrafter implements Drafter {
  requests: DraftRequest[] = [];
  constructor(
    private text: string,
    private delayMs = 5,
    private fail = false,
  ) {}
  async draft(req: DraftRequest, onText: (t: string) => void, signal?: AbortSignal) {
    this.requests.push(req);
    if (this.fail) throw new Error('boom');
    const words = this.text.split(' ');
    let out = '';
    for (const w of words) {
      await new Promise((r) => setTimeout(r, this.delayMs));
      if (signal?.aborted) throw new Error('aborted');
      out += (out ? ' ' : '') + w;
      onText(out);
    }
    return out;
  }
  async warm() {}
}

const bannerText = (v: BannerView) => v.blocks.map((b) => b.chunks.map((c) => c.text).join('')).join('');

describe('Drafted answers in the session', () => {
  it('streams a drafted answer when the Sheet has nothing, styled apart, with the closest Sheet piece as runner-up', async () => {
    const { sheet } = await fixtureSheet();
    const drafter = new FakeDrafter('At Acme Retail I built the weekly report, and at Globex I did not.');
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter(() => decision({ action: 'not_in_sheet', closest: ['K1'] })), {}, { drafter, knownText: MATERIALS });
    const modes: string[] = [];
    engine.on('banner', (v: BannerView) => modes.push(`${v.mode}${v.drafting ? '*' : ''}`));
    await engine.simulate('What is your favorite spreadsheet trick?');
    const v = engine.banner;
    expect(v.mode).toBe('drafted');
    expect(v.drafting).toBe(false);
    expect(bannerText(v)).toBe('At Acme Retail I built the weekly report, and at Globex I did not.');
    expect(v.blocks[0]!.chunks.every((c) => c.kind === 'draft')).toBe(true);
    expect(v.blocks[0]!.chunks.filter((c) => c.unverified).map((c) => c.text)).toEqual(['Globex']);
    expect(v.runnerUp?.id).toBe('K1');
    expect(modes).toContain('drafted*');
    expect(modes).not.toContain('not-in-sheet');
    // the draft was grounded in the question and the closest Sheet material
    expect(drafter.requests[0]!.question).toBe('What is your favorite spreadsheet trick?');
    expect(drafter.requests[0]!.closest[0]!.text).toContain('My drafts used to run long');
  });

  it('tells the drafter what has already been said in this interview', async () => {
    const { sheet } = await fixtureSheet();
    const drafter = new FakeDrafter('Sure.');
    const router = new FakeRouter((r) => (r.question.includes('weakness') ? decision({ ids: ['K1'] }) : decision({ action: 'not_in_sheet' })));
    const engine = new Engine(sheet, new Matcher(sheet), router, {}, { drafter, knownText: MATERIALS });
    await engine.simulate("What's your greatest weakness?");
    await engine.simulate('How did you first notice your drafts ran long?');
    expect(drafter.requests[0]!.said[0]).toContain('My drafts used to run long');
    expect(drafter.requests[0]!.recent).toEqual(["What's your greatest weakness?"]);
  });

  it('never drafts when the Sheet has an answer', async () => {
    const { sheet } = await fixtureSheet();
    const drafter = new FakeDrafter('Should not appear.');
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter(() => decision({ ids: ['K1'] })), {}, { drafter, knownText: MATERIALS });
    await engine.simulate("What's your greatest weakness?");
    expect(engine.banner.mode).toBe('confirmed');
    expect(drafter.requests).toHaveLength(0);
  });

  it('falls back to the Not in Sheet flag when drafting fails', async () => {
    const { sheet } = await fixtureSheet();
    const drafter = new FakeDrafter('x', 1, true);
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter(() => decision({ action: 'not_in_sheet', closest: ['K2'] })), {}, { drafter, knownText: MATERIALS });
    await engine.simulate('What is your favorite movie?');
    expect(engine.banner.mode).toBe('not-in-sheet');
    expect(engine.banner.closest.map((c) => c.id)).toEqual(['K2']);
  });

  it('stops a draft when the next question arrives', async () => {
    const { sheet } = await fixtureSheet();
    const drafter = new FakeDrafter('one two three four five six seven eight nine ten', 30);
    const router = new FakeRouter((r) => (r.question.includes('grades') ? decision({ ids: ['T1'] }) : decision({ action: 'not_in_sheet' })));
    const engine = new Engine(sheet, new Matcher(sheet), router, {}, { drafter, knownText: MATERIALS });
    const first = engine.simulate('What is your favorite movie?');
    await new Promise((r) => setTimeout(r, 70));
    expect(engine.banner.mode).toBe('drafted');
    await engine.simulate('Tell me about your grades.');
    await first;
    expect(engine.banner.mode).toBe('confirmed');
    expect(engine.banner.blocks[0]!.piece).toBe('T1');
  });

  it('without a drafter, behaves exactly as before', async () => {
    const { sheet } = await fixtureSheet();
    const engine = new Engine(sheet, new Matcher(sheet), new FakeRouter(() => decision({ action: 'not_in_sheet', closest: ['K2'] })));
    await engine.simulate('What is your favorite movie?');
    expect(engine.banner.mode).toBe('not-in-sheet');
  });
});
