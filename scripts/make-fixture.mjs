// Generates test/fixtures/sample-sheet.docx: a fictional Sheet with the same
// structure as a real one (headings, story labels, italic notes, numbered
// lists, a cheat-sheet table). Used by the automated tests.
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

const P = (...runs) => new Paragraph({ children: runs.map((r) => (typeof r === 'string' ? new TextRun(r) : r)) });
const B = (t) => new TextRun({ text: t, bold: true });
const I = (t) => new TextRun({ text: t, italics: true });
const H = (level, t) => new Paragraph({ heading: level, children: [new TextRun(t)] });
const H1 = (t) => H(HeadingLevel.HEADING_1, t);
const H2 = (t) => H(HeadingLevel.HEADING_2, t);
const H3 = (t) => H(HeadingLevel.HEADING_3, t);
const NUM = (ref) => (...runs) =>
  new Paragraph({ numbering: { reference: ref, level: 0 }, children: runs.map((r) => (typeof r === 'string' ? new TextRun(r) : r)) });
const finder = NUM('finder');
const ask = NUM('ask');
const fu = NUM('followups');

const cell = (t) => new TableCell({ width: { size: 2340, type: WidthType.DXA }, children: [P(t)] });
const row = (cells) => new TableRow({ children: cells.map(cell) });

const children = [
  H1('Acme Consulting Interview Prep: Jordan Example'),
  H2('How to use this sheet'),
  P('When a behavioral question comes, use the Question finder.'),
  P(B('The format.'), ' A 45-minute video interview.'),

  H2('Core narrative'),
  P('These are the answers everything else builds on.'),
  H3('Tell me about yourself (about 90 seconds)'),
  P('Sure. I studied economics at State University and spent a summer at Acme Retail.'),
  P('That summer showed me I like fixing how things work, which is why I applied here.'),
  H3('Why consulting?'),
  P('I like problems that cross teams. Consulting is that every day.'),
  P(B('If they ask how you got into consulting:'), ' A professor suggested a case competition, and I loved it.'),

  H2('Story bank'),
  P('Three stories.'),
  H3('1. The warehouse project'),
  P(B('Use it for:'), ' a problem you solved, attention to detail.'),
  P(B('Situation:'), ' At Acme Retail I worked on the warehouse project.'),
  P(B('Task:'), ' I had to explain why the counts were off.'),
  P(B('Action:'), ' I pulled the counts for every aisle and found a gap in the receiving logs.'),
  P('Then I compared the counts against the invoices, one week at a time.'),
  P(B('Result:'), ' We fixed the receiving process and the gap closed.'),
  P(B('What I learned:'), ' Start with the data you trust most.'),
  P(B('Likely follow-ups')),
  fu(B('Who noticed first?'), ' I did. Then I told my manager the same day.'),
  fu(B('What would you do differently?'), ' Ask for the invoices sooner.'),
  H3('2. Fixing the schedule'),
  P(B('Use it for:'), ' teamwork, conflict.'),
  P(B('Situation:'), ' Same project. Two teams wanted the same loading dock.'),
  P(B('Action:'), ' I proposed alternating days and wrote it down for both leads.'),
  P(B('Result:'), ' Both teams agreed, and nobody missed a delivery.'),
  H3('3. The volunteer drive'),
  P(B('Use it for:'), ' a tight deadline, motivating others.'),
  P(B('Situation:'), ' I ran a food drive with a one-week deadline.'),
  P(B('Task:'), ' We needed forty volunteers.'),
  P(B('Action:'), ' I asked each volunteer to bring one friend.'),
  P('That doubled our numbers in two days.'),
  P(B('Result:'), ' We had fifty-two volunteers by Friday.'),

  H2('Question finder'),
  P('Find the question, say the opening line, then tell the story.'),
  finder(B('Solving a hard problem.'), ' Open with: "Last year I found a gap in our inventory counts." Then tell Story 1, and focus on the invoices.'),
  finder(B('Handling a tight deadline.'), ' Open with: "I once had a week to find forty volunteers." Then the second half of Story 3. Backup: Story 2.'),
  finder(B('What motivates you.'), ' Full answer: Honestly, I like finishing things that other people gave up on.'),
  finder(B('Receiving feedback.'), ' Open with: "A manager once told me my drafts were too long." Then tell it the way it\'s written under Weakness.'),
  finder(B('Working on a team.'), ' Open with: "The best example is a scheduling fight between two teams." Then Story 2. If they want a second example, use Story 1.'),

  H2('Resume walkthrough'),
  P('Anything on your resume is fair game.'),
  H3('Education'),
  P(B('B.A. in Economics, State University.'), ' I studied economics and statistics. ', I('(Story 3)')),
  P(B('GPA 3.40.'), ' ', I('(If they ask: see "Tell me about your grades" under Tough questions.)')),
  H3('Analyst Intern, Acme Retail'),
  P(B('Built inventory reports.'), ' I built the weekly inventory report. ', I('(Story 1)'), ' If they ask what tool you used: Mostly Excel, with a little SQL.'),

  H2('Classic questions'),
  P('Short answers on purpose.'),
  H3("What's your greatest weakness?"),
  P('My drafts used to run long. Now I ask who will read it before I start.'),
  H3('What do you do for fun?'),
  P('I run and I cook.'),
  P(I('(If they ask your 5k time: about 24 minutes.)')),
  H3('What accomplishment are you most proud of?'),
  P('Probably the warehouse project. ', I('(Story 1.)'), ' If they want something outside of work, use the volunteering in Story 3.'),

  H2('Tough questions'),
  P('Answer calmly and briefly.'),
  H3('Tell me about your grades.'),
  P('They went up every year, and I took the 401(k) seminar for fun.'),
  H3('How strong are your Excel skills?'),
  P("Solid. That's how I found the gap I told you about."),

  H2('Technical talking points'),
  P('Use these only if the interviewer goes technical.'),
  H3('Asset deals and stock deals'),
  P('Buyers often prefer assets. Sellers often prefer stock.'),

  H2('Questions to ask'),
  P('Ask two or three.'),
  ask('What does a first project usually look like?'),
  ask('How do teams share work across offices?'),
  ask(B('To close:'), ' What are the next steps in the process?'),

  H2('Cheat sheet'),
  P(B('Tell me about yourself:'), ' economics → Acme → consulting'),
  new Table({
    columnWidths: [2340, 2340, 2340, 2340],
    rows: [
      row(['#', 'Story', 'Reach for it when they ask about', 'Key detail']),
      row(['1', 'Warehouse project', 'problems, attention to detail', 'gap in the logs']),
      row(['W', 'Weakness', 'your weakness, hard feedback', 'drafts too long']),
    ],
  }),
];

const numberingLevel = (format) => [{ level: 0, format, text: format === LevelFormat.DECIMAL ? '%1.' : '•' }];
const doc = new Document({
  numbering: {
    config: [
      { reference: 'finder', levels: numberingLevel(LevelFormat.DECIMAL) },
      { reference: 'ask', levels: numberingLevel(LevelFormat.DECIMAL) },
      { reference: 'followups', levels: numberingLevel(LevelFormat.BULLET) },
    ],
  },
  sections: [{ children }],
});

const out = new URL('../test/fixtures/sample-sheet.docx', import.meta.url).pathname;
mkdirSync(new URL('../test/fixtures/', import.meta.url).pathname, { recursive: true });
writeFileSync(out, await Packer.toBuffer(doc));
console.log('Wrote', out);
