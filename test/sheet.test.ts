import { describe, expect, it } from 'vitest';
import { segmentText } from '../src/core/sheet';
import { expandIds, renderPlan, scriptText, verifyChunks, VerbatimError } from '../src/core/script';
import { extractParagraphTexts, verifySheet } from '../src/core/verbatim';
import type { Sheet } from '../src/core/types';
import { fixtureSheet } from './helpers';

const sayText = (sheet: Sheet, id: string) =>
  sheet.pieces[id]!.blocks
    .flatMap((b) => b.segments)
    .filter((s) => s.kind === 'say')
    .map((s) => segmentText(sheet, s))
    .join(' ');

describe('Sheet loader (fictional fixture)', () => {
  it('passes the verbatim cross-check', async () => {
    const { sheet, documentXml } = await fixtureSheet();
    const report = verifySheet(sheet, documentXml);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(extractParagraphTexts(documentXml).length).toBe(sheet.paras.length);
  });

  it('finds the sections and pieces', async () => {
    const { sheet } = await fixtureSheet();
    expect(sheet.title).toBe('Acme Consulting Interview Prep: Jordan Example');
    expect(sheet.sections.map((s) => s.kind)).toEqual([
      'how-to-use',
      'core',
      'stories',
      'question-finder',
      'resume',
      'classic',
      'tough',
      'technical',
      'questions-to-ask',
      'cheat-sheet',
    ]);
    expect(Object.values(sheet.pieces).filter((p) => p.kind === 'story').map((p) => p.id)).toEqual(['S1', 'S2', 'S3']);
    expect(Object.values(sheet.pieces).filter((p) => p.kind === 'finder')).toHaveLength(5);
  });

  it('keeps story labels and every spoken sentence, including ones starting with "Then"', async () => {
    const { sheet } = await fixtureSheet();
    const s1 = sheet.pieces.S1!;
    const labels = s1.blocks.flatMap((b) => b.segments).filter((s) => s.kind === 'label').map((s) => segmentText(sheet, s));
    expect(labels).toEqual(['Situation:', 'Task:', 'Action:', 'Result:', 'What I learned:']);
    expect(sayText(sheet, 'S1')).toContain('Then I compared the counts against the invoices, one week at a time.');
    expect(sayText(sheet, 'S1.F1')).toBe('I did. Then I told my manager the same day.');
    // "Use it for" is matching material, not script.
    expect(sayText(sheet, 'S1')).not.toContain('a problem you solved');
    expect(s1.prompts).toContain('a problem you solved');
  });

  it('separates notes to yourself from words to say', async () => {
    const { sheet } = await fixtureSheet();
    expect(sayText(sheet, 'K3')).toBe('Probably the warehouse project.');
    expect(sheet.pieces.K3!.links.map((l) => `${l.rel}:${l.target}`)).toEqual(['more:S1', 'alternative:S3']);
    expect(sayText(sheet, 'R1')).toBe('I studied economics and statistics.');
    // Parentheses that are part of a spoken sentence stay spoken.
    expect(sayText(sheet, 'T1')).toBe('They went up every year, and I took the 401(k) seminar for fun.');
    expect(sheet.pieces.C1!.title).toBe('Tell me about yourself');
    expect(sheet.pieces.C1!.notes).toContain('about 90 seconds');
  });

  it('turns "If they ask X:" into conditional answers', async () => {
    const { sheet } = await fixtureSheet();
    expect(sayText(sheet, 'C2.I1')).toBe('A professor suggested a case competition, and I loved it.');
    expect(sayText(sheet, 'K2.I1')).toBe('about 24 minutes.');
    expect(sayText(sheet, 'R3.I1')).toBe('Mostly Excel, with a little SQL.');
    // The conditional answer is not part of the parent's default script.
    expect(sayText(sheet, 'R3')).toBe('I built the weekly inventory report.');
  });

  it('parses Question Finder openers, full answers and pairings', async () => {
    const { sheet } = await fixtureSheet();
    expect(segmentText(sheet, sheet.pieces.Q1!.opener!)).toBe('Last year I found a gap in our inventory counts.');
    expect(sheet.pairings.Q1!.parts).toEqual([{ piece: 'Q1', opener: true }, { piece: 'S1' }]);
    // "second half of Story 3": Situation, Task, Action | continuation, Result
    expect(sheet.pairings.Q2!.parts).toEqual([{ piece: 'Q2', opener: true }, { piece: 'S3', blocks: [3, 4] }]);
    expect(sheet.pairings.Q3!.parts).toEqual([{ piece: 'Q3' }]);
    expect(sayText(sheet, 'Q3')).toBe('Honestly, I like finishing things that other people gave up on.');
    // "the way it's written under Weakness"
    expect(sheet.pairings.Q4!.parts[1]).toEqual({ piece: 'K1' });
    expect(sheet.pieces.Q5!.links.map((l) => `${l.rel}:${l.target}`)).toEqual(['primary:S2', 'alternative:S1']);
  });

  it('resolves see/more pointers and the cheat sheet', async () => {
    const { sheet } = await fixtureSheet();
    expect(sheet.pieces.R2!.links).toEqual([expect.objectContaining({ rel: 'see', target: 'T1' })]);
    expect(expandIds(sheet, ['R2'])).toEqual([{ piece: 'T1' }]);
    expect(sheet.pieces.K1!.prompts).toContain('your weakness');
    expect(sheet.pieces.S1!.prompts).toContain('problems');
  });

  it('detects back-references', async () => {
    const { sheet } = await fixtureSheet();
    const refs = sheet.backrefs.map((b) => `${b.piece}:${sheet.paras[b.para]!.text.slice(b.start, b.end)}->${b.target}`);
    expect(refs).toContain('S2:Same project->S1');
    expect(refs).toContain('T2:the gap I told you about->S1');
  });

  it('renders scripts word for word, with labels and original spacing', async () => {
    const { sheet } = await fixtureSheet();
    const script = renderPlan(sheet, expandIds(sheet, ['Q2']));
    expect(scriptText(script)).toBe(
      'I once had a week to find forty volunteers.\nThat doubled our numbers in two days.\nResult: We had fifty-two volunteers by Friday.',
    );
    expect(script.cues).toContain('Then the second half of Story 3. Backup: Story 2.');
    const label = script.blocks[2]!.chunks[0]!;
    expect(label).toMatchObject({ text: 'Result:', kind: 'label', bold: true });
  });

  it('marks back-reference phrases in the rendered script', async () => {
    const { sheet } = await fixtureSheet();
    const script = renderPlan(sheet, [{ piece: 'T2' }]);
    const ref = script.blocks[0]!.chunks.find((c) => c.backref);
    expect(ref).toMatchObject({ text: 'the gap I told you about', backref: 'S1' });
    expect(scriptText(script)).toBe("Solid. That's how I found the gap I told you about.");
  });

  it('refuses to display anything that does not match the Sheet', async () => {
    const { sheet } = await fixtureSheet();
    const script = renderPlan(sheet, [{ piece: 'K1' }]);
    const tampered = script.blocks[0]!.chunks.map((c) => ({ ...c, text: c.text.replace('long', 'short') }));
    expect(() => verifyChunks(sheet, tampered)).toThrow(VerbatimError);
  });
});
