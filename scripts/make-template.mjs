// Generates templates/Interview Prep Sheet Template.docx: a blank Sheet in the
// structure the app reads, with placeholder text explaining each section.
import { mkdirSync, writeFileSync } from 'node:fs';
import { Document, HeadingLevel, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

const P = (...runs) => new Paragraph({ children: runs.map((r) => (typeof r === 'string' ? new TextRun(r) : r)) });
const B = (t) => new TextRun({ text: t, bold: true });
const I = (t) => new TextRun({ text: t, italics: true });
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(t)] });
const NUM = (ref) => (...runs) => new Paragraph({ numbering: { reference: ref, level: 0 }, children: runs.map((r) => (typeof r === 'string' ? new TextRun(r) : r)) });
const finder = NUM('finder');
const ask = NUM('ask');
const fu = NUM('followups');
const cell = (t) => new TableCell({ width: { size: 2340, type: WidthType.DXA }, children: [P(t)] });
const row = (cells) => new TableRow({ children: cells.map(cell) });

const children = [
  H1('Interview Prep: Your Name'),
  H2('How to use this sheet'),
  P('Notes to yourself about the format of this interview. Nothing in this section is shown as words to say.'),
  P(B('The format.'), ' Who you are meeting, how long, what to expect.'),

  H2('Core narrative'),
  P('Each question below is a Heading 3. The paragraphs under it are exactly what you will say.'),
  H3('Tell me about yourself'),
  P('Your answer, written the way you talk. Keep every paragraph in the Normal style; only the question line is a heading.'),
  H3('Why this role?'),
  P('Your answer.'),
  P(B('If they ask how you heard about it:'), ' A short answer that is shown only when they ask that.'),

  H2('Story bank'),
  P('Number each story. "Use it for" lists the kinds of questions the story answers; it is used for matching and never shown.'),
  H3('1. Short story title'),
  P(B('Use it for:'), ' a problem you solved, attention to detail.'),
  P(B('Situation:'), ' What was going on.'),
  P(B('Task:'), ' What you had to do.'),
  P(B('Action:'), ' What you did. Use more than one paragraph if you like.'),
  P(B('Result:'), ' What changed.'),
  P(B('What I learned:'), ' Optional.'),
  P(B('Likely follow-ups')),
  fu(B('A follow-up question they might ask?'), ' Your short answer.'),
  H3('2. Another story'),
  P(B('Use it for:'), ' teamwork, conflict.'),
  P(B('Situation:'), ' …'),
  P(B('Action:'), ' …'),
  P(B('Result:'), ' …'),

  H2('Question finder'),
  P('One numbered line per question type. The opening line, in quotes, is said first; then the story you name. Curly or straight quotes both work.'),
  finder(B('Solving a hard problem.'), ' Open with: "One sentence that answers the question directly." Then Story 1.'),
  finder(B('Working on a team.'), ' Open with: "One sentence." Then Story 2. Backup: Story 1.'),
  finder(B('What motivates you.'), ' Full answer: A complete short answer written here, when no story fits.'),

  H2('Resume walkthrough'),
  P('A Heading 3 for each resume section, then one bold line per resume item followed by the short answer. Point to a story in italics.'),
  H3('Education'),
  P(B('Your degree, school.'), ' A sentence or two for when they point at it. ', I('(Story 1)')),
  H3('Employer, role'),
  P(B('A resume bullet.'), ' What you did, in plain words. ', I('(Story 2)')),

  H2('Classic questions'),
  P('Short answers. Each question is a Heading 3.'),
  H3("What's your greatest strength?"),
  P('Your answer.'),
  H3("What's your greatest weakness?"),
  P('Your answer.'),

  H2('Tough questions'),
  P('Questions you would rather keep short.'),
  H3('Why did you leave your last job?'),
  P('Your answer.'),

  H2('Technical talking points'),
  P('Use these only if the interviewer goes technical.'),
  H3('A topic'),
  P('Two or three sentences you are comfortable explaining.'),

  H2('Questions to ask'),
  P('Numbered. The last one, marked "To close:", stays last in the app.'),
  ask('A question about the work.'),
  ask('A question about the team.'),
  ask(B('To close:'), ' What are the next steps in the process?'),

  H2('Cheat sheet'),
  P(B('Tell me about yourself:'), ' beat → beat → beat'),
  new Table({
    columnWidths: [2340, 2340, 2340, 2340],
    rows: [row(['#', 'Story', 'Reach for it when they ask about', 'Key detail']), row(['1', 'Short story title', 'problems, attention to detail', 'the key detail']), row(['2', 'Another story', 'teamwork, conflict', 'the key detail'])],
  }),
];

const level = (format) => [{ level: 0, format, text: format === LevelFormat.DECIMAL ? '%1.' : '•' }];
const doc = new Document({
  numbering: { config: [{ reference: 'finder', levels: level(LevelFormat.DECIMAL) }, { reference: 'ask', levels: level(LevelFormat.DECIMAL) }, { reference: 'followups', levels: level(LevelFormat.BULLET) }] },
  sections: [{ children }],
});
const dir = new URL('../templates/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const out = `${dir}Interview Prep Sheet Template.docx`;
writeFileSync(out, await Packer.toBuffer(doc));
console.log('Wrote', out);
