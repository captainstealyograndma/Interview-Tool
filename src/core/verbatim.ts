// Verbatim guarantees.
//
// 1. Cross-check: paragraph text is extracted a second time from the raw XML
//    with a completely separate (regex) reader and must match the DOM reader.
// 2. Every segment must be a non-empty, in-bounds slice of its paragraph.
// 3. Every chunk about to be displayed must equal its source slice.

import type { Para } from './docx';
import type { Sheet } from './types';

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Independent paragraph text extraction straight from document.xml. */
export function extractParagraphTexts(documentXml: string): string[] {
  const body = documentXml.slice(documentXml.indexOf('<w:body'));
  const out: string[] = [];
  const paraRe = /<w:p(?=[\s>/])(?:[^>]*\/>|[^>]*>([\s\S]*?)<\/w:p>)/g;
  for (const m of body.matchAll(paraRe)) {
    const inner = (m[1] ?? '')
      .replace(/<w:del\b[\s\S]*?<\/w:del>/g, '')
      .replace(/<w:moveFrom\b[\s\S]*?<\/w:moveFrom>/g, '')
      .replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '');
    let text = '';
    const tokRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<w:cr\/>|<w:noBreakHyphen\/>/g;
    for (const t of inner.matchAll(tokRe)) {
      if (t[1] !== undefined) text += decodeXml(t[1]);
      else if (t[0].startsWith('<w:tab')) text += '\t';
      else if (t[0].startsWith('<w:noBreakHyphen')) text += '-';
      else text += '\n';
    }
    out.push(text);
  }
  return out;
}

export interface VerbatimReport {
  ok: boolean;
  problems: string[];
  paragraphsChecked: number;
  segmentsChecked: number;
}

export function verifySheet(sheet: Sheet, documentXml: string): VerbatimReport {
  const problems: string[] = [];
  const independent = extractParagraphTexts(documentXml);
  if (independent.length !== sheet.paras.length) {
    problems.push(`Paragraph count differs between readers: ${sheet.paras.length} vs ${independent.length}.`);
  }
  const n = Math.min(independent.length, sheet.paras.length);
  for (let i = 0; i < n; i++) {
    if (independent[i] !== sheet.paras[i]!.text) {
      problems.push(`Paragraph ${i} text differs between readers: "${sheet.paras[i]!.text.slice(0, 60)}"`);
    }
  }
  let segmentsChecked = 0;
  for (const id of sheet.order) {
    const piece = sheet.pieces[id]!;
    const segs = piece.blocks.flatMap((b) => b.segments);
    if (piece.opener) segs.push(piece.opener);
    for (const s of segs) {
      segmentsChecked++;
      const p: Para | undefined = sheet.paras[s.para];
      if (!p) {
        problems.push(`${id}: segment points at missing paragraph ${s.para}.`);
        continue;
      }
      if (s.start < 0 || s.end > p.text.length || s.start >= s.end) {
        problems.push(`${id}: segment ${s.start}-${s.end} is outside paragraph ${s.para}.`);
        continue;
      }
      if (independent[s.para] !== undefined && independent[s.para]!.slice(s.start, s.end) !== p.text.slice(s.start, s.end)) {
        problems.push(`${id}: segment text does not match the document.`);
      }
    }
  }
  return { ok: problems.length === 0, problems, paragraphsChecked: n, segmentsChecked };
}
