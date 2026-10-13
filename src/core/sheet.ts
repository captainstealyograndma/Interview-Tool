// Turns the paragraphs of a prep Sheet into numbered pieces.
// Pieces only ever point at slices of the original paragraphs (para + offsets);
// no text is copied, rewritten or generated here.

import { createHash } from 'node:crypto';
import { readDocx, type DocxContent, type Para } from './docx';
import type {
  BackRef,
  Block,
  CheatRow,
  Link,
  Pairing,
  Piece,
  PieceKind,
  PlanPart,
  SectionInfo,
  SectionKind,
  Segment,
  SegKind,
  Sheet,
} from './types';

// ---------------------------------------------------------------- helpers

function trimRange(text: string, s: number, e: number): [number, number] {
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  return [s, e];
}

function seg(p: Para, s: number, e: number, kind: SegKind): Segment | null {
  const [a, b] = trimRange(p.text, s, e);
  return a < b ? { para: p.index, start: a, end: b, kind } : null;
}

/** Leading bold text of a paragraph, e.g. "Situation:" or "Who won?". */
function boldLead(p: Para): { end: number; text: string } | null {
  let end = 0;
  for (const r of p.runs) {
    if (!r.bold) break;
    end += r.text.length;
  }
  const text = p.text.slice(0, end).trim();
  return text ? { end, text } : null;
}

function isAllBold(p: Para): boolean {
  return p.runs.length > 0 && p.runs.every((r) => r.bold || !r.text.trim());
}

function italicFraction(p: Para, s: number, e: number): number {
  let pos = 0;
  let italic = 0;
  let total = 0;
  for (const r of p.runs) {
    const rs = pos;
    const re = pos + r.text.length;
    pos = re;
    const a = Math.max(rs, s);
    const b = Math.min(re, e);
    if (a >= b) continue;
    const chars = p.text.slice(a, b).replace(/\s/g, '').length;
    total += chars;
    if (r.italic) italic += chars;
  }
  return total ? italic / total : 0;
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[\s.:;,]+$/, '').trim();
}

const STORY_REF = /\b(?:(first|second) half of )?Story (\d+)\b/gi;

function storyRefs(text: string): { target: string; part?: 'first-half' | 'second-half' }[] {
  const out: { target: string; part?: 'first-half' | 'second-half' }[] = [];
  for (const m of text.matchAll(STORY_REF)) {
    const half = m[1]?.toLowerCase();
    out.push({ target: `S${m[2]}`, ...(half ? { part: half === 'first' ? 'first-half' : 'second-half' } : {}) } as {
      target: string;
      part?: 'first-half' | 'second-half';
    });
  }
  return out;
}

function sectionKindFor(title: string): SectionKind {
  const t = title.toLowerCase();
  if (/how to use/.test(t)) return 'how-to-use';
  if (/core/.test(t)) return 'core';
  if (/story bank|stories/.test(t)) return 'stories';
  if (/question finder|finder/.test(t)) return 'question-finder';
  if (/resume|résumé|\bcv\b/.test(t)) return 'resume';
  if (/classic/.test(t)) return 'classic';
  if (/tough|difficult|hard question|curveball/.test(t)) return 'tough';
  if (/technical/.test(t)) return 'technical';
  if (/questions? (to ask|for them|for the interviewer)|your questions/.test(t)) return 'questions-to-ask';
  if (/cheat ?sheet|quick reference/.test(t)) return 'cheat-sheet';
  return 'other';
}

const PREFIX: Record<SectionKind, string> = {
  'how-to-use': 'H',
  core: 'C',
  stories: 'S',
  'question-finder': 'Q',
  resume: 'R',
  classic: 'K',
  tough: 'T',
  technical: 'X',
  'questions-to-ask': 'A',
  'cheat-sheet': 'Z',
  other: 'O',
};

const KIND_FOR_SECTION: Record<SectionKind, PieceKind> = {
  'how-to-use': 'answer',
  core: 'answer',
  stories: 'story',
  'question-finder': 'finder',
  resume: 'resume',
  classic: 'answer',
  tough: 'answer',
  technical: 'technical',
  'questions-to-ask': 'ask',
  'cheat-sheet': 'answer',
  other: 'answer',
};

/** Notes inside parentheses: italic, or starting with a pointer word. */
const NOTE_PAREN = /^(story\s*\d|stories\b|more\s*:|then\b|if they\b|this one\b|see\b|backups?\b|use\b|about \d+ (seconds|minutes))/i;
/**
 * Sentences that are instructions to you rather than words to say. Both parts
 * must match: an instruction opening AND a pointer to another part of the Sheet.
 * ("Then in closing, I put it all together" is a spoken sentence, not an instruction.)
 */
const INSTRUCTION_START = /^(if they (want|need|prefer|push)[^:]*,|then\b|backups?:|for an? [^,]{1,40}, use\b)/i;
const POINTER = /\bStor(?:y|ies) \d+|\bunder [A-Z]|resume walkthrough|\bsee "/;
const isInstruction = (sentence: string) => INSTRUCTION_START.test(sentence) && POINTER.test(sentence);
const CONDITION = /^if they ask\b[^:]{0,80}:/i;

interface PendingLink {
  piece: string;
  rel: Link['rel'];
  name: string;
  section?: SectionKind;
  text: string;
}

// ---------------------------------------------------------------- parser

class Builder {
  pieces: Record<string, Piece> = {};
  order: string[] = [];
  sections: SectionInfo[] = [];
  cheat: Sheet['cheat'] = { lines: [], header: [], rows: [] };
  pending: PendingLink[] = [];
  warnings: string[] = [];
  counters: Record<string, number> = {};

  constructor(public paras: Para[]) {}

  text(s: Segment): string {
    return this.paras[s.para]!.text.slice(s.start, s.end);
  }

  newPiece(section: SectionInfo, title: string, extra: Partial<Piece> = {}): Piece {
    const prefix = PREFIX[section.kind];
    let id = extra.id;
    if (!id) {
      this.counters[prefix] = (this.counters[prefix] ?? 0) + 1;
      id = `${prefix}${this.counters[prefix]}`;
    }
    const piece: Piece = {
      id,
      kind: KIND_FOR_SECTION[section.kind],
      section: section.kind,
      sectionTitle: section.title,
      title,
      prompts: [],
      blocks: [],
      notes: [],
      links: [],
      children: [],
      ...extra,
    };
    if (this.pieces[id]) {
      this.warnings.push(`Duplicate piece id ${id} ("${title}"); renamed.`);
      piece.id = `${id}_${this.order.length}`;
    }
    this.pieces[piece.id] = piece;
    this.order.push(piece.id);
    return piece;
  }

  childPiece(parent: Piece, kind: PieceKind, title: string, suffix: string): Piece {
    const n = parent.children.filter((c) => c.startsWith(`${parent.id}.${suffix}`)).length + 1;
    const id = `${parent.id}.${suffix}${n}`;
    const piece: Piece = {
      id,
      kind,
      section: parent.section,
      sectionTitle: parent.sectionTitle,
      title,
      prompts: [],
      blocks: [],
      notes: [],
      links: [],
      children: [],
      parent: parent.id,
      ...(parent.group ? { group: parent.group } : {}),
    };
    this.pieces[id] = piece;
    this.order.push(id);
    parent.children.push(id);
    return piece;
  }

  addLinksFromNote(piece: Piece, note: string, defaultRel: Link['rel']) {
    for (const r of storyRefs(note)) {
      piece.links.push({ rel: defaultRel, target: r.target, ...(r.part ? { part: r.part } : {}), text: note });
    }
    const more = /more:\s*([^)]+?)\)?\.?$/i.exec(note);
    if (more) this.pending.push({ piece: piece.id, rel: 'more', name: stripTrailingPunct(more[1]!), text: note });
    const see = /see\s+"([^"]+)"(?:\s+under\s+([^.)]+))?/i.exec(note);
    if (see) {
      const section = see[2] ? sectionKindFor(see[2]) : undefined;
      this.pending.push({ piece: piece.id, rel: 'see', name: see[1]!, ...(section ? { section } : {}), text: note });
    }
  }

  /**
   * Splits [s,e) of a paragraph into say/note segments. A conditional answer
   * ("If they ask X: answer") becomes a child piece of `piece`.
   */
  classifyInto(piece: Piece, p: Para, s: number, e: number, block: Block) {
    const text = p.text;
    // 1. Parenthetical notes.
    const notes: [number, number][] = [];
    const parenRe = /\(([^()]*)\)\.?/g;
    parenRe.lastIndex = s;
    for (let m = parenRe.exec(text); m && m.index < e; m = parenRe.exec(text)) {
      const ms = m.index;
      const me = Math.min(ms + m[0].length, e);
      const inner = m[1]!.trim();
      if (italicFraction(p, ms, me) > 0.6 || NOTE_PAREN.test(inner)) notes.push([ms, me]);
    }

    let cursor = s;
    const regions: { s: number; e: number; note: boolean }[] = [];
    for (const [ns, ne] of notes) {
      if (ns > cursor) regions.push({ s: cursor, e: ns, note: false });
      regions.push({ s: ns, e: ne, note: true });
      cursor = ne;
    }
    if (cursor < e) regions.push({ s: cursor, e, note: false });

    for (let ri = 0; ri < regions.length; ri++) {
      const r = regions[ri]!;
      if (r.note) {
        const sg = seg(p, r.s, r.e, 'note');
        if (!sg) continue;
        const noteText = this.text(sg);
        const inner = noteText.replace(/^\(/, '').replace(/\)\.?$/, '').trim();
        const cond = /^if they ask\b([^:]{0,80}):\s*(.+)$/i.exec(inner);
        if (cond && !/^see\b/i.test(cond[2]!.trim())) {
          // "(If they ask your chess rating: around 1100.)" -> conditional answer "around 1100."
          const child = this.childPiece(piece, 'conditional', `If they ask${cond[1]}`, 'I');
          child.prompts.push(cond[1]!.trim());
          const answerStart = text.indexOf(cond[2]!, sg.start);
          const answerEnd = answerStart + cond[2]!.length;
          const c1 = seg(p, sg.start, answerStart, 'condition');
          const c2 = seg(p, answerStart, answerEnd, 'say');
          child.blocks.push({ para: p.index, segments: [c1, c2].filter(Boolean) as Segment[] });
          block.segments.push(sg);
          continue;
        }
        block.segments.push(sg);
        piece.notes.push(noteText);
        this.addLinksFromNote(piece, noteText, 'more');
        continue;
      }
      // 2. Sentences: instructions become notes; "If they ask X:" starts a conditional answer.
      const sentRe = /[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g;
      sentRe.lastIndex = r.s;
      let pendingSay: [number, number] | null = null;
      const flushSay = () => {
        if (pendingSay) {
          const sg = seg(p, pendingSay[0], pendingSay[1], 'say');
          if (sg) block.segments.push(sg);
          pendingSay = null;
        }
      };
      for (let m = sentRe.exec(text); m && m.index < r.e; m = sentRe.exec(text)) {
        if (m[0].length === 0) {
          sentRe.lastIndex++;
          continue;
        }
        const ss = m.index;
        const se = Math.min(ss + m[0].length, r.e);
        const sentence = text.slice(ss, se).trim();
        if (CONDITION.test(sentence)) {
          flushSay();
          const colon = text.indexOf(':', ss);
          const child = this.childPiece(piece, 'conditional', stripTrailingPunct(text.slice(ss, colon)), 'I');
          child.prompts.push(text.slice(ss, colon).replace(/^if they ask\s*/i, '').trim());
          const c1 = seg(p, ss, colon + 1, 'condition');
          const c2 = seg(p, colon + 1, r.e, 'say');
          child.blocks.push({ para: p.index, segments: [c1, c2].filter(Boolean) as Segment[] });
          // The rest of this region belongs to the conditional answer (a child piece).
          break;
        }
        if (isInstruction(sentence)) {
          flushSay();
          const sg = seg(p, ss, se, 'note');
          if (sg) {
            block.segments.push(sg);
            const noteText = this.text(sg);
            piece.notes.push(noteText);
            this.addLinksFromNote(piece, noteText, /^if they|^for an?/i.test(sentence) ? 'alternative' : 'more');
          }
          continue;
        }
        pendingSay = pendingSay ? [pendingSay[0], se] : [ss, se];
      }
      flushSay();
    }
  }

  // ------------------------------------------------------------ sections

  build(): Omit<Sheet, 'hash' | 'pairings' | 'backrefs' | 'keyterms'> {
    const paras = this.paras;
    const headingLevels = paras.filter((p) => p.headingLevel !== null && p.text.trim()).map((p) => p.headingLevel!);
    const counts = new Map<number, number>();
    for (const l of headingLevels) counts.set(l, (counts.get(l) ?? 0) + 1);
    const levels = [...counts.keys()].sort((a, b) => a - b);
    let title = '';
    let sectionLevel = levels[0] ?? 1;
    const first = paras.find((p) => p.headingLevel !== null && p.text.trim());
    if (first && counts.get(first.headingLevel!) === 1 && levels.length > 1) {
      title = first.text.trim();
      sectionLevel = levels[levels.indexOf(first.headingLevel!) + 1]!;
    }
    const itemLevel = sectionLevel + 1;

    let section: SectionInfo = { kind: 'other', title: '', rules: [] };
    let current: Piece | null = null;
    let inFollowups = false;
    let resumeGroup = '';

    for (const p of paras) {
      if (!p.text.trim()) continue;
      if (p.headingLevel !== null && p.text.trim() === title && !this.sections.length) continue;

      if (p.headingLevel !== null && p.headingLevel <= sectionLevel) {
        section = { kind: sectionKindFor(p.text), title: p.text.trim(), rules: [] };
        this.sections.push(section);
        current = null;
        inFollowups = false;
        resumeGroup = '';
        continue;
      }

      if (p.table) {
        this.tableRow(section, p);
        continue;
      }

      if (p.headingLevel !== null && p.headingLevel >= itemLevel) {
        inFollowups = false;
        if (section.kind === 'resume') {
          resumeGroup = p.text.trim();
          current = null;
        } else {
          current = this.headingPiece(section, p);
        }
        continue;
      }

      switch (section.kind) {
        case 'how-to-use':
          section.rules.push(p.text.trim());
          break;
        case 'cheat-sheet':
          this.cheat.lines.push(p.text.trim());
          break;
        case 'question-finder':
          if (p.list) this.finderItem(section, p);
          else section.rules.push(p.text.trim());
          break;
        case 'questions-to-ask':
          if (p.list) this.askItem(section, p);
          else section.rules.push(p.text.trim());
          break;
        case 'resume': {
          if (!resumeGroup && !current) {
            section.rules.push(p.text.trim());
            break;
          }
          const lead = boldLead(p);
          if (lead && !isAllBold(p)) {
            current = this.newPiece(section, stripTrailingPunct(lead.text), { group: resumeGroup });
            current.prompts.push(stripTrailingPunct(lead.text), resumeGroup);
            const block: Block = { para: p.index, segments: [] };
            const t = seg(p, 0, lead.end, 'title');
            if (t) block.segments.push(t);
            this.classifyInto(current, p, lead.end, p.text.length, block);
            current.blocks.push(block);
          } else if (current && current.group === resumeGroup) {
            const block: Block = { para: p.index, segments: [] };
            this.classifyInto(current, p, 0, p.text.length, block);
            current.blocks.push(block);
          } else {
            current = this.newPiece(section, resumeGroup, { group: resumeGroup });
            current.prompts.push(resumeGroup);
            const block: Block = { para: p.index, segments: [] };
            this.classifyInto(current, p, 0, p.text.length, block);
            current.blocks.push(block);
          }
          break;
        }
        case 'stories': {
          if (!current) {
            section.rules.push(p.text.trim());
            break;
          }
          const lead = boldLead(p);
          if (isAllBold(p) && /follow.?ups?/i.test(p.text)) {
            inFollowups = true;
            break;
          }
          if (inFollowups && lead) {
            const story = current.parent ? this.pieces[current.parent]! : current;
            const fu = this.childPiece(story, 'followup', stripTrailingPunct(lead.text), 'F');
            fu.prompts.push(lead.text.trim());
            const block: Block = { para: p.index, segments: [] };
            const t = seg(p, 0, lead.end, 'title');
            if (t) block.segments.push(t);
            this.classifyInto(fu, p, lead.end, p.text.length, block);
            fu.blocks.push(block);
            break;
          }
          const story = current;
          if (lead && /^use (it|this) (for|when)/i.test(lead.text)) {
            const rest = p.text.slice(lead.end).trim();
            story.notes.push(p.text.trim());
            story.prompts.push(
              ...rest
                .replace(/\.$/, '')
                .split(/,|;/)
                .map((x) => x.replace(/^\s*(and|or)\s+/i, '').trim())
                .filter(Boolean),
            );
            break;
          }
          const block: Block = { para: p.index, segments: [] };
          if (lead && /:$/.test(lead.text) && !CONDITION.test(lead.text)) {
            const l = seg(p, 0, lead.end, 'label');
            if (l) block.segments.push(l);
            this.classifyInto(story, p, lead.end, p.text.length, block);
          } else {
            this.classifyInto(story, p, 0, p.text.length, block);
          }
          story.blocks.push(block);
          break;
        }
        default: {
          // core, classic, tough, technical, other
          if (!current) {
            section.rules.push(p.text.trim());
            break;
          }
          const lead = boldLead(p);
          if (lead && CONDITION.test(lead.text)) {
            const child = this.childPiece(current, 'conditional', stripTrailingPunct(lead.text), 'I');
            child.prompts.push(lead.text.replace(/^if they ask\s*/i, '').replace(/:$/, '').trim());
            const block: Block = { para: p.index, segments: [] };
            const c = seg(p, 0, lead.end, 'condition');
            if (c) block.segments.push(c);
            this.classifyInto(child, p, lead.end, p.text.length, block);
            child.blocks.push(block);
            break;
          }
          const block: Block = { para: p.index, segments: [] };
          this.classifyInto(current, p, 0, p.text.length, block);
          if (block.segments.length) current.blocks.push(block);
        }
      }
    }

    // Drop empty blocks (paragraphs that were entirely notes stay, so notes keep their source).
    return {
      title: title || this.sections[0]?.title || 'Interview Sheet',
      paras,
      pieces: this.pieces,
      order: this.order,
      sections: this.sections,
      cheat: this.cheat,
      warnings: this.warnings,
    };
  }

  headingPiece(section: SectionInfo, p: Para): Piece {
    const raw = p.text.trim();
    if (section.kind === 'stories') {
      const m = /^(\d+)[.)]\s*(.+)$/.exec(raw);
      const num = m ? Number(m[1]) : (this.counters['S'] ?? 0) + 1;
      const title = m ? m[2]!.trim() : raw;
      if (!m) this.counters['S'] = num;
      const piece = this.newPiece(section, title, { id: `S${num}`, number: num });
      piece.prompts.push(title);
      return piece;
    }
    // Strip parenthetical notes from headings: "Tell me about yourself (about 90 seconds)".
    const paren = /\s*\(([^()]*)\)\s*$/.exec(raw);
    const title = paren && NOTE_PAREN.test(paren[1]!) ? raw.slice(0, paren.index).trim() : raw;
    const piece = this.newPiece(section, title);
    if (paren && title !== raw) piece.notes.push(paren[1]!.trim());
    piece.prompts.push(stripTrailingPunct(title));
    return piece;
  }

  finderItem(section: SectionInfo, p: Para) {
    const lead = boldLead(p);
    const title = lead ? stripTrailingPunct(lead.text) : p.text.slice(0, 60);
    const piece = this.newPiece(section, title);
    piece.prompts.push(title);
    const block: Block = { para: p.index, segments: [] };
    if (lead) {
      const t = seg(p, 0, lead.end, 'title');
      if (t) block.segments.push(t);
    }
    const text = p.text;
    const from = lead ? lead.end : 0;
    const openMatch = /open with:\s*"/i.exec(text.slice(from));
    const fullMatch = /full answer:\s*/i.exec(text.slice(from));
    if (fullMatch) {
      const labelStart = from + fullMatch.index;
      const sayStart = labelStart + fullMatch[0].length;
      const n0 = seg(p, from, labelStart, 'note');
      const n1 = seg(p, labelStart, sayStart, 'note');
      if (n0) block.segments.push(n0);
      if (n1) block.segments.push(n1);
      this.classifyInto(piece, p, sayStart, text.length, block);
      piece.blocks.push(block);
      return;
    }
    let instrStart = from;
    if (openMatch) {
      const quoteOpen = from + openMatch.index + openMatch[0].length;
      const quoteClose = text.indexOf('"', quoteOpen);
      const end = quoteClose === -1 ? text.length : quoteClose;
      const pre = seg(p, from, quoteOpen, 'note');
      if (pre) block.segments.push(pre);
      const opener = seg(p, quoteOpen, end, 'say');
      if (opener) {
        piece.opener = opener;
        block.segments.push(opener);
      }
      instrStart = Math.min(text.length, end + 1);
      // Text before "Open with" (e.g. "For a client, open with") qualifies the opener.
      const qualifier = text.slice(from, from + openMatch.index).trim().replace(/,$/, '');
      if (qualifier) piece.notes.push(qualifier);
    }
    const instr = seg(p, instrStart, text.length, 'note');
    if (instr) {
      block.segments.push(instr);
      const instrText = this.text(instr);
      piece.notes.push(instrText);
      this.finderLinks(piece, instrText);
    }
    piece.blocks.push(block);
  }

  finderLinks(piece: Piece, instr: string) {
    const sentences = instr.match(/[^.]+\.?/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
    let primaryFound = false;
    for (const s of sentences) {
      if (/^backups?:/i.test(s)) {
        for (const r of storyRefs(s)) piece.links.push({ rel: 'backup', target: r.target, ...(r.part ? { part: r.part } : {}), text: s });
        const resumeRef = /the (.+?) in your resume walkthrough/i.exec(s);
        if (resumeRef) this.pending.push({ piece: piece.id, rel: 'backup', name: resumeRef[1]!, section: 'resume', text: s });
        const under = /under ([A-Z][\w ]+)/.exec(s);
        if (under) this.pending.push({ piece: piece.id, rel: 'backup', name: under[1]!, text: s });
        continue;
      }
      if (/^(if they want|for an? )/i.test(s)) {
        for (const r of storyRefs(s)) piece.links.push({ rel: 'alternative', target: r.target, ...(r.part ? { part: r.part } : {}), text: s });
        continue;
      }
      const refs = storyRefs(s);
      if (!primaryFound && refs.length) {
        const r = refs[0]!;
        piece.links.push({ rel: 'primary', target: r.target, ...(r.part ? { part: r.part } : {}), text: s });
        primaryFound = true;
        continue;
      }
      const under = /written under ([A-Z][\w' ]+)|under ([A-Z][\w' ]+)/.exec(s);
      if (!primaryFound && under) {
        this.pending.push({ piece: piece.id, rel: 'primary', name: (under[1] ?? under[2])!, text: s });
        primaryFound = true;
      }
    }
  }

  askItem(section: SectionInfo, p: Para) {
    const lead = boldLead(p);
    const block: Block = { para: p.index, segments: [] };
    let from = 0;
    if (lead && !isAllBold(p)) {
      const n = seg(p, 0, lead.end, 'note');
      if (n) block.segments.push(n);
      from = lead.end;
    }
    const sayText = p.text.slice(from).trim();
    const piece = this.newPiece(section, sayText);
    if (lead && !isAllBold(p)) piece.notes.push(stripTrailingPunct(lead.text));
    piece.prompts.push(sayText);
    this.classifyInto(piece, p, from, p.text.length, block);
    piece.blocks.push(block);
  }

  tableRow(section: SectionInfo, p: Para) {
    if (section.kind !== 'cheat-sheet') {
      this.cheat.lines.push(p.text.trim());
      return;
    }
    const t = p.table!;
    if (t.row === 0) {
      this.cheat.header[t.col] = p.text.trim();
      return;
    }
    let row = this.cheat.rows.find((r) => r.key === `${t.table}:${t.row}`);
    if (!row) {
      row = { key: `${t.table}:${t.row}`, cells: [] };
      this.cheat.rows.push(row);
    }
    row.cells[t.col] = ((row.cells[t.col] ?? '') + ' ' + p.text).trim();
  }

  resolvePending() {
    for (const pl of this.pending) {
      const target = this.findByName(pl.name, pl.section);
      const piece = this.pieces[pl.piece]!;
      if (target) piece.links.push({ rel: pl.rel, target, text: pl.text });
      else this.warnings.push(`${piece.id}: could not find "${pl.name}" referenced in "${pl.text}".`);
    }
  }

  findByName(name: string, section?: SectionKind): string | undefined {
    const want = normalizeTitle(name);
    const wantWords = new Set(want.split(' ').filter((w) => w.length > 2));
    let best: { id: string; score: number } | undefined;
    for (const id of this.order) {
      const piece = this.pieces[id]!;
      if (section && piece.section !== section) continue;
      if (piece.kind === 'finder' || piece.kind === 'conditional' || piece.kind === 'followup') continue;
      const t = normalizeTitle(piece.title);
      let score = 0;
      if (t === want) score = 100;
      else if (t.includes(want) || want.includes(t)) score = 50;
      else {
        const words = t.split(' ');
        score = words.filter((w) => wantWords.has(w)).length * 10;
      }
      if (score > 0 && (!best || score > best.score)) best = { id, score };
    }
    return best && best.score >= 10 ? best.id : undefined;
  }

  applyCheatSheet() {
    const header = this.cheat.header.map((h) => h.toLowerCase());
    const whenCol = header.findIndex((h) => /reach|when|use/.test(h));
    const storyCol = header.findIndex((h) => /story/.test(h));
    for (const row of this.cheat.rows) {
      const key = (row.cells[0] ?? '').trim();
      let target: string | undefined;
      if (/^\d+$/.test(key) && this.pieces[`S${key}`]) target = `S${key}`;
      else if (storyCol >= 0) target = this.findByName(row.cells[storyCol] ?? '');
      if (!target) continue;
      row.target = target;
      const when = whenCol >= 0 ? row.cells[whenCol] : undefined;
      if (when) {
        this.pieces[target]!.prompts.push(
          ...when
            .split(/,|;/)
            .map((x) => x.replace(/^\s*(and|or)\s+/i, '').trim())
            .filter(Boolean),
        );
      }
    }
    // "**Tell me about yourself:** 3L -> ..." lines point at core answers by title.
    for (const line of this.cheat.lines) {
      const m = /^([^:]{3,60}):/.exec(line);
      if (!m) continue;
      const target = this.findByName(m[1]!);
      if (target && this.pieces[target]!.section !== 'questions-to-ask') this.pieces[target]!.prompts.push(m[1]!.trim());
    }
  }
}

// ---------------------------------------------------------------- pairings

/** Indexes of a story's speakable blocks. */
export function speakableBlocks(sheet: Pick<Sheet, 'pieces'>, pieceId: string): number[] {
  const piece = sheet.pieces[pieceId];
  if (!piece) return [];
  return piece.blocks
    .map((b, i) => (b.segments.some((s) => s.kind === 'say' || s.kind === 'label') ? i : -1))
    .filter((i) => i >= 0);
}

export function halfBlocks(sheet: Pick<Sheet, 'pieces'>, pieceId: string, part: 'first-half' | 'second-half'): number[] {
  const blocks = speakableBlocks(sheet, pieceId);
  const cut = Math.ceil(blocks.length / 2);
  return part === 'first-half' ? blocks.slice(0, cut) : blocks.slice(cut);
}

export function defaultPairings(sheet: Pick<Sheet, 'pieces' | 'order'>): Record<string, Pairing> {
  const out: Record<string, Pairing> = {};
  for (const id of sheet.order) {
    const piece = sheet.pieces[id]!;
    if (piece.kind !== 'finder') continue;
    const parts: PlanPart[] = [];
    if (piece.opener) parts.push({ piece: id, opener: true });
    else if (speakableBlocks(sheet, id).length) parts.push({ piece: id });
    const primary = piece.links.find((l) => l.rel === 'primary');
    if (primary && sheet.pieces[primary.target]) {
      parts.push(
        primary.part
          ? { piece: primary.target, blocks: halfBlocks(sheet, primary.target, primary.part) }
          : { piece: primary.target },
      );
    }
    out[id] = { finder: id, parts, source: 'default' };
  }
  return out;
}

// ---------------------------------------------------------------- back-references

const BACKREF_PATTERNS: { re: RegExp; resolve: 'phrase' | 'previous' }[] = [
  { re: /\b((?:the|that|this|those|my) [\w' -]{2,40}? I (?:told you about|mentioned(?: earlier| before)?|talked about))\b/gi, resolve: 'phrase' },
  { re: /\b((?:like|as) I (?:said|mentioned)(?: earlier| before)?)\b/gi, resolve: 'phrase' },
  { re: /^(Same (?:trial|case|summer|project|job|team|class|course|internship|lab))\b/gi, resolve: 'previous' },
];

function findBackrefs(sheet: Pick<Sheet, 'pieces' | 'order' | 'paras'>): BackRef[] {
  const out: BackRef[] = [];
  const stories = sheet.order.filter((id) => sheet.pieces[id]!.kind === 'story');
  const storyText = (id: string) =>
    normalizeTitle(
      [sheet.pieces[id]!.title, ...sheet.pieces[id]!.blocks.flatMap((b) => b.segments.map((s) => sheet.paras[s.para]!.text.slice(s.start, s.end)))].join(' '),
    );
  for (const id of sheet.order) {
    const piece = sheet.pieces[id]!;
    for (const block of piece.blocks) {
      for (const s of block.segments) {
        if (s.kind !== 'say') continue;
        const text = sheet.paras[s.para]!.text.slice(s.start, s.end);
        for (const { re, resolve } of BACKREF_PATTERNS) {
          re.lastIndex = 0;
          for (const m of text.matchAll(re)) {
            let target: string | undefined;
            if (resolve === 'previous') {
              const own = piece.kind === 'story' ? piece : piece.parent ? sheet.pieces[piece.parent] : undefined;
              const idx = own ? stories.indexOf(own.id) : -1;
              const noun = m[1]!.split(' ')[1]!.toLowerCase();
              for (let i = idx - 1; i >= 0 && !target; i--) if (storyText(stories[i]!).includes(noun)) target = stories[i];
            } else {
              const words = normalizeTitle(m[1]!)
                .split(' ')
                .filter((w) => w.length > 2 && !['the', 'told', 'you', 'about', 'mentioned', 'earlier', 'before', 'talked', 'that', 'this', 'those', 'said'].includes(w));
              let best = 0;
              for (const sid of stories) {
                if (sid === id || sid === piece.parent) continue;
                const title = normalizeTitle(sheet.pieces[sid]!.title);
                const score = words.filter((w) => title.includes(w)).length * 2 + words.filter((w) => storyText(sid).includes(w)).length;
                if (score > best) {
                  best = score;
                  target = sid;
                }
              }
              if (best < 1) target = undefined;
            }
            if (target) out.push({ piece: id, para: s.para, start: s.start + m.index!, end: s.start + m.index! + m[1]!.length, target });
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- keyterms

const COMMON = new Set(
  'I A The This That These Those It In On At For And But Or So If Then When What Why How Who Where Which My Your Our Their His Her We You They He She Yes No Sure Honestly Last First Second Next Once One Two Three Four Five Story Use Open Backup Full Situation Task Action Result Likely Monday Tuesday'.split(' '),
);

function keytermsFor(sheet: Pick<Sheet, 'pieces' | 'order' | 'paras' | 'sections'>): string[] {
  const counts = new Map<string, number>();
  const add = (t: string, w = 1) => {
    const k = t.trim();
    if (k.length < 2 || k.length > 40) return;
    counts.set(k, (counts.get(k) ?? 0) + w);
  };
  for (const p of sheet.paras) {
    for (const r of p.runs) if (r.italic && r.text.trim().split(' ').length <= 3 && !/^\(/.test(r.text.trim())) add(r.text.replace(/[.,;:]$/, ''), 3);
    for (const m of p.text.matchAll(/\b(?:[A-Z]{2,6}|[A-Z][a-z]?\.(?:[A-Z][a-z]?\.)+|\d{3}\([a-z]\)(?:\(\d+\))?)(?=[\s,.;:)]|$)/g)) add(m[0], 2);
    for (const m of p.text.matchAll(/(?<=[a-z,] )[A-Z][a-z]{3,}(?: [A-Z][a-z]+)*/g)) if (!COMMON.has(m[0])) add(m[0], 1);
  }
  return [...counts.entries()]
    .filter(([t]) => !COMMON.has(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([t]) => t);
}

// ---------------------------------------------------------------- entry points

export function buildSheet(content: DocxContent): Sheet {
  const b = new Builder(content.paras);
  const base = b.build();
  b.resolvePending();
  b.applyCheatSheet();
  for (const id of base.order) {
    const piece = base.pieces[id]!;
    piece.prompts = [...new Set(piece.prompts.map((x) => x.trim()).filter(Boolean))];
    piece.notes = [...new Set(piece.notes)];
  }
  const partial = { ...base, pairings: {}, backrefs: [], keyterms: [] };
  return {
    ...partial,
    hash: createHash('sha256').update(content.documentXml).digest('hex').slice(0, 16),
    pairings: defaultPairings(partial),
    backrefs: findBackrefs(partial),
    keyterms: keytermsFor(partial),
    warnings: b.warnings,
  };
}

export async function loadSheet(data: Uint8Array | ArrayBuffer): Promise<{ sheet: Sheet; documentXml: string }> {
  const content = await readDocx(data);
  return { sheet: buildSheet(content), documentXml: content.documentXml };
}

export function segmentText(sheet: Pick<Sheet, 'paras'>, s: Segment): string {
  return sheet.paras[s.para]!.text.slice(s.start, s.end);
}
