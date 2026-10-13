// Usage: npm run inspect-sheet -- path/to/Sheet.docx [--json out.json]
// Prints how the Sheet was split into pieces, the Question Finder pairings,
// back-references, and the verbatim check result.

import { readFileSync, writeFileSync } from 'node:fs';
import { loadSheet, segmentText } from '../core/sheet';
import { verifySheet } from '../core/verbatim';
import { expandIds, renderPlan, scriptText } from '../core/script';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: inspect-sheet <Sheet.docx> [--json out.json]');
    process.exit(2);
  }
  const { sheet, documentXml } = await loadSheet(readFileSync(file));
  const report = verifySheet(sheet, documentXml);

  console.log(`# ${sheet.title}  (hash ${sheet.hash})`);
  console.log(`Paragraphs: ${sheet.paras.length}   Pieces: ${sheet.order.length}`);
  console.log(`Verbatim check: ${report.ok ? 'PASS' : 'FAIL'} (${report.paragraphsChecked} paragraphs, ${report.segmentsChecked} segments)`);
  for (const p of report.problems) console.log(`  ! ${p}`);
  for (const w of sheet.warnings) console.log(`  warning: ${w}`);

  for (const s of sheet.sections) {
    console.log(`\n## ${s.title} [${s.kind}]`);
    for (const r of s.rules) console.log(`  rule: ${r.slice(0, 110)}`);
    for (const id of sheet.order) {
      const p = sheet.pieces[id]!;
      if (p.sectionTitle !== s.title || p.parent) continue;
      const say = p.blocks
        .flatMap((b) => b.segments)
        .filter((x) => x.kind === 'say')
        .map((x) => segmentText(sheet, x))
        .join(' ');
      console.log(`  [${id}] ${p.title}`);
      if (p.opener) console.log(`       opener: ${segmentText(sheet, p.opener)}`);
      console.log(`       say(${say.split(/\s+/).length}w): ${say.slice(0, 100)}${say.length > 100 ? '…' : ''}`);
      if (p.prompts.length) console.log(`       prompts: ${p.prompts.join(' | ').slice(0, 160)}`);
      for (const n of p.notes) console.log(`       note: ${n.slice(0, 120)}`);
      for (const l of p.links) console.log(`       link: ${l.rel} -> ${l.target}${l.part ? ` (${l.part})` : ''}`);
      for (const c of p.children) {
        const cp = sheet.pieces[c]!;
        const cs = cp.blocks.flatMap((b) => b.segments).filter((x) => x.kind === 'say').map((x) => segmentText(sheet, x)).join(' ');
        console.log(`       └ [${c}] ${cp.title} => ${cs.slice(0, 90)}`);
      }
    }
  }

  console.log('\n## Question Finder pairings');
  for (const [id, pr] of Object.entries(sheet.pairings)) {
    const desc = pr.parts.map((pt) => (pt.opener ? `${pt.piece}:opener` : pt.blocks ? `${pt.piece}[blocks ${pt.blocks.join(',')}]` : pt.piece)).join(' + ');
    console.log(`  ${id}: ${desc}`);
  }
  console.log('\n## Back-references');
  for (const b of sheet.backrefs) {
    console.log(`  ${b.piece}: "${sheet.paras[b.para]!.text.slice(b.start, b.end)}" needs ${b.target}`);
  }
  console.log(`\n## Keyterms\n  ${sheet.keyterms.join(', ')}`);

  const sample = Object.keys(sheet.pairings)[0];
  if (sample) {
    console.log(`\n## Sample render of ${sample}`);
    console.log(scriptText(renderPlan(sheet, expandIds(sheet, [sample]))));
  }

  const jsonAt = process.argv.indexOf('--json');
  if (jsonAt > 0 && process.argv[jsonAt + 1]) writeFileSync(process.argv[jsonAt + 1]!, JSON.stringify(sheet, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
