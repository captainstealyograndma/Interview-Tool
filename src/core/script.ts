// Turns a plan (which pieces / which paragraphs) into displayable chunks.
// Every non-bridge chunk is a slice of a Sheet paragraph and is re-verified
// against that paragraph before it is returned.

import type { Para } from './docx';
import type { BackRef, Piece, PlanPart, Segment, Sheet } from './types';

export interface Chunk {
  text: string;
  /**
   * 'space' is a single display space between two slices whose source gap was a note.
   * 'draft' is AI-written text, shown only when the Sheet has no answer, always styled apart.
   */
  kind: 'say' | 'label' | 'bridge' | 'space' | 'draft';
  /** Draft only: a personal claim not found in your materials. Shown with a dotted underline. */
  unverified?: boolean;
  bold: boolean;
  italic: boolean;
  para?: number;
  start?: number;
  end?: number;
  /** Story this phrase depends on (faint underline if not yet shown). */
  backref?: string;
}

export interface ScriptBlock {
  piece: string;
  chunks: Chunk[];
}

export interface Script {
  /** Short description for the label line. */
  label: string;
  /** Notes to yourself from the Sheet (never read aloud). */
  cues: string[];
  blocks: ScriptBlock[];
  /** Ids of every piece that contributes text (used to track what has been shown). */
  pieces: string[];
}

export class VerbatimError extends Error {}

export function pieceLabel(sheet: Sheet, id: string): string {
  const p = sheet.pieces[id];
  if (!p) return id;
  switch (p.kind) {
    case 'story':
      return `Story ${p.number ?? ''} · ${p.title}`.trim();
    case 'followup': {
      const parent = p.parent ? sheet.pieces[p.parent] : undefined;
      return `Story ${parent?.number ?? ''} follow-up · ${p.title}`;
    }
    case 'finder':
      return `Question Finder · ${p.title}`;
    case 'resume':
      return p.group && p.group !== p.title ? `Resume · ${p.group} · ${p.title}` : `Resume · ${p.title}`;
    case 'conditional': {
      const parent = p.parent ? sheet.pieces[p.parent] : undefined;
      return `${parent?.title ?? ''} · ${p.title}`;
    }
    case 'ask':
      return 'Questions to ask';
    default:
      return `${p.sectionTitle} · ${p.title}`;
  }
}

function runSlices(para: Para, start: number, end: number): { s: number; e: number; bold: boolean; italic: boolean }[] {
  const out: { s: number; e: number; bold: boolean; italic: boolean }[] = [];
  let pos = 0;
  for (const r of para.runs) {
    const rs = pos;
    const re = pos + r.text.length;
    pos = re;
    const a = Math.max(rs, start);
    const b = Math.min(re, end);
    if (a < b) out.push({ s: a, e: b, bold: r.bold, italic: r.italic });
  }
  return out;
}

function segmentChunks(sheet: Sheet, s: Segment, backrefs: BackRef[]): Chunk[] {
  const para = sheet.paras[s.para]!;
  const kind: Chunk['kind'] = s.kind === 'label' ? 'label' : 'say';
  // Cut points: run boundaries and back-reference boundaries.
  const refs = backrefs.filter((b) => b.para === s.para && b.start >= s.start && b.end <= s.end);
  const cuts = new Set<number>([s.start, s.end]);
  for (const r of refs) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  const chunks: Chunk[] = [];
  for (const rs of runSlices(para, s.start, s.end)) {
    const points = [...cuts].filter((c) => c > rs.s && c < rs.e).sort((a, b) => a - b);
    let from = rs.s;
    for (const to of [...points, rs.e]) {
      if (to <= from) continue;
      const ref = refs.find((r) => from >= r.start && to <= r.end);
      chunks.push({
        text: para.text.slice(from, to),
        kind,
        bold: rs.bold || kind === 'label',
        italic: rs.italic,
        para: s.para,
        start: from,
        end: to,
        ...(ref ? { backref: ref.target } : {}),
      });
      from = to;
    }
  }
  return chunks;
}

function speakableSegments(piece: Piece, blockIdx?: number[]): Segment[][] {
  const blocks = blockIdx ? blockIdx.map((i) => piece.blocks[i]).filter(Boolean) : piece.blocks;
  return blocks
    .map((b) => b!.segments.filter((s) => s.kind === 'say' || s.kind === 'label'))
    .filter((segs) => segs.length > 0);
}

/** Chunks for a run of segments from one paragraph, keeping the original spacing between them. */
function blockChunks(sheet: Sheet, segs: Segment[]): Chunk[] {
  const out: Chunk[] = [];
  let prev: Segment | undefined;
  for (const s of segs) {
    if (prev && prev.para === s.para && s.start > prev.end) {
      const gap = sheet.paras[s.para]!.text.slice(prev.end, s.start);
      if (/^\s+$/.test(gap)) out.push({ text: gap, kind: 'say', bold: false, italic: false, para: s.para, start: prev.end, end: s.start });
      else out.push({ text: ' ', kind: 'space', bold: false, italic: false });
    }
    out.push(...segmentChunks(sheet, s, sheet.backrefs));
    prev = s;
  }
  return out;
}

export function verifyChunks(sheet: Sheet, chunks: Chunk[]): void {
  for (const c of chunks) {
    if (c.kind === 'bridge' || c.kind === 'draft') continue;
    if (c.kind === 'space') {
      if (c.text !== ' ') throw new VerbatimError('Unexpected spacing chunk.');
      continue;
    }
    const para = c.para !== undefined ? sheet.paras[c.para] : undefined;
    if (!para || c.start === undefined || c.end === undefined || para.text.slice(c.start, c.end) !== c.text) {
      throw new VerbatimError(`Refusing to display text that does not match the Sheet: "${c.text.slice(0, 40)}"`);
    }
  }
}

export function hasSpeakable(piece: Piece): boolean {
  return piece.blocks.some((b) => b.segments.some((s) => s.kind === 'say' || s.kind === 'label'));
}

/**
 * Expands a Question Finder id to its approved pairing; other ids are shown whole.
 * A piece with nothing to say (e.g. a resume line that only says "see Tell me about
 * your grades") is replaced by the piece its note points to.
 */
export function expandIds(sheet: Sheet, ids: string[]): PlanPart[] {
  const parts: PlanPart[] = [];
  for (const id of ids) {
    const piece = sheet.pieces[id];
    if (!piece) continue;
    if (piece.kind === 'finder' && sheet.pairings[id]) {
      parts.push(...sheet.pairings[id]!.parts);
    } else if (!hasSpeakable(piece)) {
      const link = piece.links.find((l) => l.rel === 'see' || l.rel === 'more');
      if (link && sheet.pieces[link.target]) parts.push({ piece: link.target });
    } else {
      parts.push({ piece: id });
    }
  }
  return parts;
}

export function renderPlan(sheet: Sheet, parts: PlanPart[], opts: { bridge?: string; label?: string } = {}): Script {
  const blocks: ScriptBlock[] = [];
  const cues: string[] = [];
  const used: string[] = [];
  for (const part of parts) {
    const piece = sheet.pieces[part.piece];
    if (!piece) continue;
    if (!used.includes(piece.id)) used.push(piece.id);
    for (const n of piece.notes) if (!/^use (it|this) (for|when)/i.test(n) && !cues.includes(n)) cues.push(n);
    if (part.opener) {
      if (piece.opener) blocks.push({ piece: piece.id, chunks: segmentChunks(sheet, piece.opener, sheet.backrefs) });
      continue;
    }
    for (const segs of speakableSegments(piece, part.blocks)) {
      blocks.push({ piece: piece.id, chunks: blockChunks(sheet, segs) });
    }
  }
  if (opts.bridge && blocks.length) {
    blocks[0]!.chunks.unshift({ text: opts.bridge, kind: 'bridge', bold: false, italic: false }, { text: ' ', kind: 'space', bold: false, italic: false });
  }
  for (const b of blocks) verifyChunks(sheet, b.chunks);
  const first = parts[0] ? sheet.pieces[parts[0].piece] : undefined;
  const label = opts.label ?? (first ? pieceLabel(sheet, first.id) : '');
  return { label, cues, blocks, pieces: used };
}

/** Plain text of a script, for logs and tests. */
export function scriptText(script: Script): string {
  return script.blocks.map((b) => b.chunks.map((c) => c.text).join('')).join('\n');
}
