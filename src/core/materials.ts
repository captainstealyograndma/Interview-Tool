// Your other documents: resume, cover letter, job posting. Their text is used
// only as grounding for drafted answers and for transcription vocabulary.
// Nothing from them is ever shown as script.

import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { readDocx } from './docx';

export type MaterialKind = 'resume' | 'cover' | 'posting';

export interface Material {
  kind: MaterialKind;
  path: string;
  /** Plain text, paragraphs separated by newlines. */
  text: string;
  hash: string;
  words: number;
}

export type Materials = Partial<Record<MaterialKind, Material>>;

export const MATERIAL_LABEL: Record<MaterialKind, string> = {
  resume: 'Resume',
  cover: 'Cover letter',
  posting: 'Job posting',
};

export async function extractText(path: string, data: Uint8Array): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (ext === '.docx') {
    const { paras } = await readDocx(data);
    return paras
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join('\n');
  }
  if (ext === '.pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(Uint8Array.from(data));
    const { text } = await pdfText(pdf, { mergePages: true });
    return text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }
  if (ext === '.txt' || ext === '.md') {
    return new TextDecoder('utf-8').decode(data).replace(/\r\n/g, '\n').trim();
  }
  throw new Error(`Unsupported file type "${ext || 'none'}". Use a Word (.docx), PDF or plain text file.`);
}

export async function loadMaterial(kind: MaterialKind, path: string, data: Uint8Array): Promise<Material> {
  const text = await extractText(path, data);
  if (!text.trim()) throw new Error(`No text could be read from ${path}. If it is a scanned PDF, export it as text first.`);
  return {
    kind,
    path,
    text,
    hash: createHash('sha256').update(data).digest('hex').slice(0, 16),
    words: (text.match(/\S+/g) ?? []).length,
  };
}

/** The grounding block for the drafter: every material, clearly labeled. */
export function materialsBlock(m: Materials): string {
  const parts: string[] = [];
  for (const kind of ['resume', 'cover', 'posting'] as MaterialKind[]) {
    const mat = m[kind];
    if (mat) parts.push(`=== ${MATERIAL_LABEL[kind].toUpperCase()} ===\n${mat.text}`);
  }
  return parts.join('\n\n');
}

const COMMON = new Set(
  'The This That These Those And But For With From Our Your Their Its Summer Fall Spring Winter January February March April May June July August September October November December Experience Education Skills Interests Coursework Dean List Club Analyst Intern Manager Senior Associate Team Office Role Position Candidate Candidates Analysts Interns Requirements Responsibilities About Apply'.split(
    ' ',
  ),
);

/** Names, acronyms and multi-word proper nouns worth priming the transcriber with. */
export function materialKeyterms(m: Materials, max = 30): string[] {
  const counts = new Map<string, number>();
  const add = (t: string, w: number) => {
    const k = t.replace(/[.,;:()]+$/, '').trim();
    if (k.length < 2 || k.length > 40 || COMMON.has(k)) return;
    counts.set(k, (counts.get(k) ?? 0) + w);
  };
  for (const mat of Object.values(m)) {
    for (const line of mat.text.split('\n')) {
      for (const t of line.matchAll(/\b[A-Z]{2,6}\b/g)) add(t[0], 2);
      for (const t of line.matchAll(/\b[A-Z][a-z]{2,}(?: (?:of |the |& )?[A-Z][a-z]{2,})+/g)) {
        const ws = t[0].split(' ');
        while (ws.length > 1 && COMMON.has(ws[0]!)) ws.shift();
        if (ws.length > 1) add(ws.join(' '), 3);
      }
      for (const t of line.matchAll(/(?<=[a-z,] )[A-Z][a-z]{3,}\b/g)) add(t[0], 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}
