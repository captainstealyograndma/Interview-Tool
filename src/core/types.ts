import type { Para } from './docx';

export type { Para, Run } from './docx';

/**
 * What a slice of a paragraph is for.
 * - say: words you say out loud. Shown in the banner exactly as written.
 * - label: a story label such as "Situation:". Shown in the banner, in bold, as in the Sheet.
 * - note: a note to yourself ("(Story 3)", "Then tell Story 3..."). Never shown as words to say.
 * - condition: "If they ask X:" lead-in for a conditional answer. Shown in the label line.
 * - title: an item title (resume line, Question Finder title). Shown in the label line.
 */
export type SegKind = 'say' | 'label' | 'note' | 'condition' | 'title';

export interface Segment {
  para: number;
  start: number;
  end: number;
  kind: SegKind;
}

/** One source paragraph's contribution to a piece. */
export interface Block {
  para: number;
  segments: Segment[];
}

export type SectionKind =
  | 'how-to-use'
  | 'core'
  | 'stories'
  | 'question-finder'
  | 'resume'
  | 'classic'
  | 'tough'
  | 'technical'
  | 'questions-to-ask'
  | 'cheat-sheet'
  | 'other';

export type PieceKind = 'answer' | 'story' | 'followup' | 'finder' | 'resume' | 'technical' | 'ask' | 'conditional';

export interface Link {
  rel: 'primary' | 'backup' | 'alternative' | 'more' | 'see';
  target: string;
  part?: 'first-half' | 'second-half';
  /** The note text the link came from. */
  text: string;
}

export interface Piece {
  /** Stable id: C1 core, S3 story, S3.F1 follow-up, Q12 finder, R4 resume, K2 classic, T5 tough, X1 technical, A3 ask, O1 other, <parent>.I1 conditional. */
  id: string;
  kind: PieceKind;
  section: SectionKind;
  sectionTitle: string;
  title: string;
  number?: number;
  group?: string;
  /** Phrasings this piece answers. Used for matching only, never displayed as script. */
  prompts: string[];
  blocks: Block[];
  /** Notes to yourself, shown as a small cue. */
  notes: string[];
  links: Link[];
  parent?: string;
  children: string[];
  /** Question Finder: the opening line (inside the quotes). */
  opener?: Segment;
}

export interface PlanPart {
  piece: string;
  /** Block indexes within the piece; omitted means the whole piece. */
  blocks?: number[];
  /** Only the Question Finder opening line. */
  opener?: boolean;
}

export interface Pairing {
  finder: string;
  parts: PlanPart[];
  source: 'default' | 'edited';
}

export interface BackRef {
  piece: string;
  para: number;
  start: number;
  end: number;
  /** The story that must have been shown for this phrase to make sense. */
  target: string;
}

export interface SectionInfo {
  kind: SectionKind;
  title: string;
  /** Section-level instructions ("Use these only if the interviewer goes technical"). */
  rules: string[];
}

export interface CheatRow {
  key: string;
  cells: string[];
  target?: string;
}

export interface Sheet {
  title: string;
  hash: string;
  paras: Para[];
  pieces: Record<string, Piece>;
  order: string[];
  sections: SectionInfo[];
  cheat: { lines: string[]; header: string[]; rows: CheatRow[] };
  pairings: Record<string, Pairing>;
  backrefs: BackRef[];
  keyterms: string[];
  warnings: string[];
}
