// Renders the Sheet as a numbered catalog for Claude. Claude reads this to
// choose piece ids; it is never asked to reproduce the text.

import { pieceLabel, scriptText, renderPlan, expandIds } from './script';
import { segmentText } from './sheet';
import type { Piece, Sheet } from './types';

const KIND_LABEL: Record<Piece['kind'], string> = {
  answer: 'answer',
  story: 'story',
  followup: 'follow-up',
  finder: 'question-finder entry',
  resume: 'resume line',
  technical: 'technical talking point',
  ask: 'question to ask',
  conditional: 'conditional answer',
};

function sayText(sheet: Sheet, piece: Piece): string {
  return piece.blocks
    .flatMap((b) => b.segments)
    .filter((s) => s.kind === 'say' || s.kind === 'label')
    .map((s) => segmentText(sheet, s))
    .join(' ');
}

function describePairing(sheet: Sheet, id: string): string {
  const pr = sheet.pairings[id];
  if (!pr) return '';
  return pr.parts
    .map((p) => {
      if (p.opener) return 'its opening line';
      if (p.piece === id) return 'its full answer';
      const label = pieceLabel(sheet, p.piece);
      return p.blocks ? `${label} (paragraphs ${p.blocks.join(', ')} only)` : label;
    })
    .join(' + ');
}

function renderPiece(sheet: Sheet, piece: Piece, indent = ''): string[] {
  const lines: string[] = [];
  lines.push(`${indent}[${piece.id}] ${KIND_LABEL[piece.kind]} — ${piece.title}`);
  const extraPrompts = piece.prompts.filter((p) => p !== piece.title && p.replace(/[?.]$/, '') !== piece.title.replace(/[?.]$/, ''));
  if (extraPrompts.length) lines.push(`${indent}  answers: ${extraPrompts.join('; ')}`);
  const notes = piece.notes.filter((n) => !/^use (it|this) (for|when)/i.test(n));
  if (notes.length) lines.push(`${indent}  notes: ${notes.join(' | ')}`);
  if (piece.kind === 'finder') {
    if (piece.opener) lines.push(`${indent}  opening line: "${segmentText(sheet, piece.opener)}"`);
    lines.push(`${indent}  shows: ${describePairing(sheet, piece.id)}`);
    if (!piece.opener) lines.push(`${indent}  text: ${sayText(sheet, piece)}`);
    const alts = piece.links.filter((l) => l.rel !== 'primary');
    if (alts.length) lines.push(`${indent}  also: ${alts.map((l) => `${l.rel} ${l.target}`).join(', ')}`);
  } else if (piece.kind === 'story') {
    piece.blocks.forEach((b, i) => {
      const t = b.segments
        .filter((s) => s.kind === 'say' || s.kind === 'label')
        .map((s) => segmentText(sheet, s))
        .join(' ');
      if (t) lines.push(`${indent}  (${i}) ${t}`);
    });
  } else {
    const t = sayText(sheet, piece);
    if (t) lines.push(`${indent}  text: ${t}`);
    const links = piece.links.map((l) => `${l.rel} ${l.target}`);
    if (links.length) lines.push(`${indent}  points to: ${links.join(', ')}`);
  }
  for (const c of piece.children) lines.push(...renderPiece(sheet, sheet.pieces[c]!, indent + '  '));
  return lines;
}

export function renderCatalog(sheet: Sheet): string {
  const lines: string[] = [`SHEET: ${sheet.title}`];
  for (const section of sheet.sections) {
    lines.push('', `=== ${section.title} ===`);
    for (const r of section.rules) lines.push(`Guidance: ${r}`);
    for (const id of sheet.order) {
      const piece = sheet.pieces[id]!;
      if (piece.parent || piece.sectionTitle !== section.title) continue;
      lines.push(...renderPiece(sheet, piece));
    }
    if (section.kind === 'cheat-sheet') {
      for (const l of sheet.cheat.lines) lines.push(`Cheat sheet: ${l}`);
      for (const row of sheet.cheat.rows) {
        lines.push(`Cheat sheet row${row.target ? ` for ${row.target}` : ''}: ${sheet.cheat.header.map((h, i) => `${h}: ${row.cells[i] ?? ''}`).join(' | ')}`);
      }
    }
  }
  return lines.join('\n');
}

/** Ids the router may return. */
export function routableIds(sheet: Sheet): string[] {
  return [...sheet.order];
}

/** Plain text of what a set of ids would display (for bridge validation). */
export function displayText(sheet: Sheet, ids: string[]): string {
  return scriptText(renderPlan(sheet, expandIds(sheet, ids)));
}
