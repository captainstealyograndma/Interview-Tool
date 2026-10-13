// Builds what the review screen shows, and applies pairing edits.

import { defaultPairings, segmentText, speakableBlocks } from './sheet';
import { expandIds, pieceLabel, renderPlan } from './script';
import type { Pairing, Piece, Sheet } from './types';
import type { ReviewData, ReviewPairing, ReviewPiece, SheetSummary } from '../shared/ipc';

function reviewPiece(sheet: Sheet, piece: Piece): ReviewPiece {
  return {
    id: piece.id,
    kind: piece.kind,
    title: piece.title,
    prompts: piece.prompts,
    blocks: piece.blocks.map((b) => b.segments.map((s) => ({ text: segmentText(sheet, s), kind: s.kind }))),
    links: piece.links.map((l) => `${l.rel} → ${pieceLabel(sheet, l.target)}${l.part ? ` (${l.part.replace('-', ' ')})` : ''}`),
    children: piece.children.map((c) => reviewPiece(sheet, sheet.pieces[c]!)),
  };
}

function pairingTarget(sheet: Sheet, pairing: Pairing): string | undefined {
  return pairing.parts.find((p) => p.piece !== pairing.finder)?.piece ?? sheet.pieces[pairing.finder]?.links.find((l) => l.rel === 'primary')?.target;
}

export function buildReview(sheet: Sheet, summary: SheetSummary): ReviewData {
  const sections = sheet.sections.map((s) => ({
    title: s.title,
    kind: s.kind,
    rules: s.rules,
    pieces: sheet.order
      .filter((id) => !sheet.pieces[id]!.parent && sheet.pieces[id]!.sectionTitle === s.title)
      .map((id) => reviewPiece(sheet, sheet.pieces[id]!)),
  }));

  const pairings: ReviewPairing[] = Object.values(sheet.pairings).map((pr) => {
    const finder = sheet.pieces[pr.finder]!;
    const targetId = pairingTarget(sheet, pr);
    const part = pr.parts.find((p) => p.piece === targetId);
    const target = targetId ? sheet.pieces[targetId] : undefined;
    return {
      finder: pr.finder,
      title: finder.title,
      edited: pr.source === 'edited',
      preview: renderPlan(sheet, expandIds(sheet, [pr.finder])).blocks,
      instruction: finder.notes.join(' '),
      ...(target
        ? {
            target: {
              id: target.id,
              label: pieceLabel(sheet, target.id),
              paragraphs: speakableBlocks(sheet, target.id).map((i) => ({
                index: i,
                text: target.blocks[i]!.segments
                  .filter((s) => s.kind === 'say' || s.kind === 'label')
                  .map((s) => segmentText(sheet, s))
                  .join(' '),
                selected: !!part && (!part.blocks || part.blocks.includes(i)),
              })),
            },
          }
        : {}),
    };
  });

  const backrefs = sheet.backrefs.map((b) => ({
    piece: b.piece,
    phrase: sheet.paras[b.para]!.text.slice(b.start, b.end),
    target: b.target,
    targetLabel: pieceLabel(sheet, b.target),
  }));

  return { summary, sections, pairings, backrefs };
}

/** Sets which paragraphs of the target story a Question Finder entry shows; null resets to the default. */
export function editPairing(sheet: Sheet, finder: string, blocks: number[] | null): Pairing {
  const def = defaultPairings(sheet)[finder];
  if (!def) throw new Error(`${finder} is not a Question Finder entry.`);
  if (blocks === null) return def;
  const current = sheet.pairings[finder] ?? def;
  const targetId = pairingTarget(sheet, current);
  const opener = current.parts.filter((p) => p.piece === finder);
  if (!targetId) return { ...current, source: 'edited' };
  const all = speakableBlocks(sheet, targetId);
  const chosen = all.filter((i) => blocks.includes(i));
  const parts = [...opener, ...(chosen.length === all.length ? [{ piece: targetId }] : chosen.length ? [{ piece: targetId, blocks: chosen }] : [])];
  return { finder, parts, source: 'edited' };
}

/** Applies saved edits on top of the defaults for this Sheet. */
export function applySavedPairings(sheet: Sheet, saved: Record<string, Pairing>): void {
  for (const [id, p] of Object.entries(saved)) {
    if (!sheet.pairings[id]) continue;
    const valid = p.parts.every((part) => sheet.pieces[part.piece] && (part.blocks ?? []).every((b) => sheet.pieces[part.piece]!.blocks[b]));
    if (valid) sheet.pairings[id] = p;
  }
}
