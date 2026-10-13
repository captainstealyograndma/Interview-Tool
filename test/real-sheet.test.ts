// Checks against your real Sheet. Runs only when private/sheet.docx (or SHEET_PATH) exists,
// so nothing personal ever needs to be committed.
import { describe, expect, it } from 'vitest';
import { segmentText } from '../src/core/sheet';
import { expandIds, renderPlan } from '../src/core/script';
import { verifySheet } from '../src/core/verbatim';
import { hasRealSheet, realSheet } from './helpers';

describe.skipIf(!hasRealSheet)('Your real Sheet', () => {
  it('passes the verbatim cross-check with no warnings', async () => {
    const { sheet, documentXml } = await realSheet();
    const report = verifySheet(sheet, documentXml);
    expect(report.problems).toEqual([]);
    expect(sheet.warnings).toEqual([]);
  });

  it('never classifies a spoken sentence as a note', async () => {
    const { sheet } = await realSheet();
    for (const id of sheet.order) {
      const piece = sheet.pieces[id]!;
      for (const s of piece.blocks.flatMap((b) => b.segments)) {
        if (s.kind !== 'note') continue;
        const t = segmentText(sheet, s);
        const pointer = /\(|Story \d+|under [A-Z]|walkthrough|^Open with|^Full answer|^For a |^To close|^If they ask/;
        expect(pointer.test(t), `${id} note looks spoken: "${t}"`).toBe(true);
      }
    }
  });

  it('renders every piece and every pairing without a verbatim error', async () => {
    const { sheet } = await realSheet();
    for (const id of sheet.order) expect(() => renderPlan(sheet, expandIds(sheet, [id]))).not.toThrow();
    for (const q of Object.keys(sheet.pairings)) {
      const script = renderPlan(sheet, expandIds(sheet, [q]));
      expect(script.blocks.length, `${q} renders nothing`).toBeGreaterThan(0);
    }
  });

  it('gives every Question Finder entry an opener or a full answer, and a story when it names one', async () => {
    const { sheet } = await realSheet();
    for (const [q, pairing] of Object.entries(sheet.pairings)) {
      expect(pairing.parts.length, q).toBeGreaterThan(0);
      const piece = sheet.pieces[q]!;
      const namesStory = piece.notes.some((n) => /Story \d+|under [A-Z]/.test(n));
      if (namesStory) expect(pairing.parts.length, q).toBe(2);
    }
  });
});
