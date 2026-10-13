// Reads a .docx into an ordered list of paragraphs with their runs and formatting.
// This is the only place the Word file is interpreted; every piece of text the
// tool can ever display is a slice of a paragraph produced here.

import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export interface Para {
  /** Position in document order (body and table paragraphs alike). */
  index: number;
  styleId: string | null;
  /** 1 for "Heading 1", 2 for "Heading 2"...; 0 for Title; null for body text. */
  headingLevel: number | null;
  list: { numId: string; level: number } | null;
  runs: Run[];
  /** Concatenation of all run texts: the canonical text of the paragraph. */
  text: string;
  table?: { table: number; row: number; col: number };
}

export interface DocxContent {
  paras: Para[];
  /** Raw word/document.xml, kept for the independent verbatim cross-check. */
  documentXml: string;
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

type El = Element;

function children(el: El): El[] {
  const out: El[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as El);
  return out;
}

function local(el: El): string {
  return el.localName ?? el.nodeName.replace(/^.*:/, '');
}

function child(el: El, name: string): El | undefined {
  return children(el).find((c) => local(c) === name);
}

function attr(el: El | undefined, name: string): string | null {
  if (!el) return null;
  return el.getAttributeNS(W_NS, name) || el.getAttribute(`w:${name}`) || null;
}

function toggleOn(el: El | undefined): boolean {
  if (!el) return false;
  const v = attr(el, 'val');
  return v === null || !['0', 'false', 'off', 'none'].includes(v.toLowerCase());
}

interface StyleInfo {
  name: string;
  basedOn: string | null;
  outlineLvl: number | null;
  bold: boolean;
  italic: boolean;
}

function readStyles(xml: string | undefined): Map<string, StyleInfo> {
  const map = new Map<string, StyleInfo>();
  if (!xml) return map;
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const styles = doc.getElementsByTagNameNS(W_NS, 'style');
  for (let i = 0; i < styles.length; i++) {
    const s = styles[i] as unknown as El;
    const id = attr(s, 'styleId');
    if (!id) continue;
    const pPr = child(s, 'pPr');
    const rPr = child(s, 'rPr');
    const outline = pPr ? attr(child(pPr, 'outlineLvl'), 'val') : null;
    map.set(id, {
      name: attr(child(s, 'name'), 'val') ?? id,
      basedOn: attr(child(s, 'basedOn'), 'val'),
      outlineLvl: outline !== null ? Number(outline) : null,
      bold: rPr ? toggleOn(child(rPr, 'b')) : false,
      italic: rPr ? toggleOn(child(rPr, 'i')) : false,
    });
  }
  return map;
}

function headingLevelFor(styleId: string | null, styles: Map<string, StyleInfo>): number | null {
  let id = styleId;
  for (let depth = 0; id && depth < 10; depth++) {
    const s = styles.get(id);
    const name = (s?.name ?? id).toLowerCase().replace(/\s+/g, ' ').trim();
    if (name === 'title') return 0;
    const m = /^heading ?(\d)$/.exec(name);
    if (m) return Number(m[1]);
    if (s?.outlineLvl !== null && s?.outlineLvl !== undefined && s.outlineLvl < 9) return s.outlineLvl + 1;
    id = s?.basedOn ?? null;
  }
  return null;
}

function runText(r: El): string {
  let t = '';
  for (const c of children(r)) {
    switch (local(c)) {
      case 't':
        t += c.textContent ?? '';
        break;
      case 'tab':
        t += '\t';
        break;
      case 'br':
      case 'cr':
        t += '\n';
        break;
      case 'noBreakHyphen':
        t += '-';
        break;
      default:
        break;
    }
  }
  return t;
}

function readRun(r: El, styles: Map<string, StyleInfo>): Run {
  const rPr = child(r, 'rPr');
  const rStyle = rPr ? attr(child(rPr, 'rStyle'), 'val') : null;
  const rs = rStyle ? styles.get(rStyle) : undefined;
  const rsName = (rs?.name ?? rStyle ?? '').toLowerCase();
  const u = rPr ? child(rPr, 'u') : undefined;
  return {
    text: runText(r),
    bold: (rPr ? toggleOn(child(rPr, 'b')) : false) || !!rs?.bold || rsName === 'strong',
    italic: (rPr ? toggleOn(child(rPr, 'i')) : false) || !!rs?.italic || rsName === 'emphasis',
    underline: !!u && (attr(u, 'val') ?? 'single') !== 'none',
  };
}

/** Collects runs in order, descending into hyperlinks, insertions, smart tags, content controls; skipping deletions. */
function collectRuns(el: El, styles: Map<string, StyleInfo>, out: Run[]): void {
  for (const c of children(el)) {
    const name = local(c);
    if (name === 'r') out.push(readRun(c, styles));
    else if (name === 'del' || name === 'moveFrom' || name === 'pPr') continue;
    else collectRuns(c, styles, out);
  }
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && last.bold === r.bold && last.italic === r.italic && last.underline === r.underline) {
      last.text += r.text;
    } else out.push({ ...r });
  }
  return out;
}

export async function readDocx(data: Uint8Array | ArrayBuffer): Promise<DocxContent> {
  const zip = await JSZip.loadAsync(data);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('This file is not a Word document (word/document.xml is missing).');
  const documentXml = await docFile.async('string');
  const stylesXml = await zip.file('word/styles.xml')?.async('string');
  const styles = readStyles(stylesXml);

  const doc = new DOMParser().parseFromString(documentXml, 'text/xml');
  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0] as unknown as El | undefined;
  if (!body) throw new Error('The Word document has no body.');

  const paras: Para[] = [];
  let tableCount = 0;

  const addPara = (p: El, table?: Para['table']) => {
    const pPr = child(p, 'pPr');
    const styleId = pPr ? attr(child(pPr, 'pStyle'), 'val') : null;
    const numPr = pPr ? child(pPr, 'numPr') : undefined;
    const numId = numPr ? attr(child(numPr, 'numId'), 'val') : null;
    const ilvl = numPr ? attr(child(numPr, 'ilvl'), 'val') : null;
    const raw: Run[] = [];
    collectRuns(p, styles, raw);
    const runs = mergeRuns(raw);
    paras.push({
      index: paras.length,
      styleId,
      headingLevel: headingLevelFor(styleId, styles),
      list: numId && numId !== '0' ? { numId, level: Number(ilvl ?? 0) } : null,
      runs,
      text: runs.map((r) => r.text).join(''),
      ...(table ? { table } : {}),
    });
  };

  const walk = (el: El) => {
    for (const c of children(el)) {
      const name = local(c);
      if (name === 'p') addPara(c);
      else if (name === 'tbl') {
        const t = tableCount++;
        children(c)
          .filter((r) => local(r) === 'tr')
          .forEach((tr, row) => {
            children(tr)
              .filter((tc) => local(tc) === 'tc')
              .forEach((tc, col) => {
                const ps = tc.getElementsByTagNameNS(W_NS, 'p');
                for (let i = 0; i < ps.length; i++) addPara(ps[i] as unknown as El, { table: t, row, col });
              });
          });
      } else if (name === 'sdt') {
        const content = child(c, 'sdtContent');
        if (content) walk(content);
      }
    }
  };
  walk(body);

  return { paras, documentXml };
}
