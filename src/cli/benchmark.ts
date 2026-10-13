// Measures matching accuracy and speed against a test set of interviewer questions.
//
// Usage:
//   npm run benchmark -- <Sheet.docx> <testset.json> [--claude claude-opus-5-5|claude-haiku-5-5] [--phrasings]
//
// Without --claude, only the instant on-device matcher is measured.
// With --claude (needs ANTHROPIC_API_KEY), each question is also routed by Claude.
//
// testset.json: [{ "q": "...", "expect": ["Q1"], "ok": ["S3"], "shown": ["S1"], "kind": "in" | "not" | "ignore" }]

import { readFileSync, writeFileSync } from 'node:fs';
import { Matcher } from '../core/matcher';
import { ClaudeRouter, generatePhrasings, type RouterModel } from '../core/router';
import { loadSheet } from '../core/sheet';
import { expandIds, pieceLabel } from '../core/script';
import { isBackchannel } from '../core/text';

interface Case {
  q: string;
  expect?: string[];
  ok?: string[];
  shown?: string[];
  kind?: 'in' | 'not' | 'ignore';
}

type Verdict = 'exact' | 'acceptable' | 'wrong' | 'flagged' | 'ignored';

function judge(c: Case, action: 'show' | 'not_in_sheet' | 'ignore', ids: string[], sheet: Parameters<typeof expandIds>[0]): Verdict {
  const kind = c.kind ?? 'in';
  if (action === 'ignore') return kind === 'ignore' ? 'exact' : 'ignored';
  if (action === 'not_in_sheet') return kind === 'not' ? 'exact' : kind === 'ignore' ? 'acceptable' : 'flagged';
  if (kind !== 'in') return 'wrong';
  const first = ids[0];
  if (!first) return 'wrong';
  const firstShown = expandIds(sheet, [first])[0]?.piece;
  const expect = c.expect ?? [];
  if (expect.includes(first)) return 'exact';
  // A Question Finder entry that expands to the expected story, or vice versa, is acceptable.
  const ok = new Set([...(c.ok ?? [])]);
  if (ok.has(first) || (firstShown && (ok.has(firstShown) || expect.some((e) => expandIds(sheet, [e]).some((p) => p.piece === first))))) return 'acceptable';
  return 'wrong';
}

function summarize(name: string, verdicts: Verdict[], latencies: number[]) {
  const n = verdicts.length;
  const count = (v: Verdict) => verdicts.filter((x) => x === v).length;
  const pct = (k: number) => `${((100 * k) / n).toFixed(1)}%`;
  latencies.sort((a, b) => a - b);
  const p = (q: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!.toFixed(0) : '-');
  console.log(`\n== ${name} (${n} questions)`);
  console.log(`  exact ${pct(count('exact'))}   acceptable ${pct(count('acceptable'))}   wrong script ${pct(count('wrong'))}   flagged (should have answered) ${pct(count('flagged'))}   ignored a real question ${pct(count('ignored'))}`);
  if (latencies.length) console.log(`  latency ms: median ${p(0.5)}   p90 ${p(0.9)}   max ${p(1)}`);
}

async function main() {
  const [sheetPath, testPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!sheetPath || !testPath) {
    console.error('Usage: benchmark <Sheet.docx> <testset.json> [--claude <model>] [--phrasings]');
    process.exit(2);
  }
  const { sheet } = await loadSheet(readFileSync(sheetPath));
  const cases = JSON.parse(readFileSync(testPath, 'utf8')) as Case[];
  const claudeAt = process.argv.indexOf('--claude');
  const model = claudeAt > 0 ? (process.argv[claudeAt + 1] as RouterModel) : undefined;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

  let phrasings: Record<string, string[]> = {};
  if (process.argv.includes('--phrasings')) {
    if (!apiKey) throw new Error('--phrasings needs ANTHROPIC_API_KEY');
    console.log('Generating matching phrasings with Claude…');
    phrasings = await generatePhrasings(sheet, { apiKey, model: model ?? 'claude-opus-5-5' }, (d, t) => process.stdout.write(`\r  ${d}/${t}`));
    console.log();
  }

  const matcher = new Matcher(sheet, phrasings);
  const instantV: Verdict[] = [];
  const instantLat: number[] = [];
  const rows: string[] = [];
  for (const c of cases) {
    const t0 = performance.now();
    const m = matcher.match(c.q, { shown: c.shown ?? [] });
    instantLat.push(performance.now() - t0);
    const action = isBackchannel(c.q) ? 'ignore' : m.score >= 0.45 ? 'show' : 'not_in_sheet';
    const v = judge(c, action, m.ids, sheet);
    instantV.push(v);
    if (v === 'wrong' || v === 'flagged' || v === 'ignored') rows.push(`  instant ${v.padEnd(8)} "${c.q}" -> ${m.ids[0] ?? '-'} (${m.score.toFixed(2)}) want ${(c.expect ?? [c.kind]).join('/')}`);
  }
  summarize('Instant matcher (on-device)', instantV, instantLat);

  if (model) {
    if (!apiKey) throw new Error('--claude needs ANTHROPIC_API_KEY');
    const router = new ClaudeRouter(sheet, { apiKey, model, timeoutMs: 20000 });
    await router.warm();
    const v: Verdict[] = [];
    const lat: number[] = [];
    for (const c of cases) {
      try {
        const d = await router.route({ question: c.q, recent: [], shown: (c.shown ?? []).map((id) => ({ id, label: pieceLabel(sheet, id) })) });
        lat.push(d.latencyMs);
        const verdict = judge(c, d.action, d.ids, sheet);
        v.push(verdict);
        if (verdict === 'wrong' || verdict === 'flagged' || verdict === 'ignored') {
          rows.push(`  ${model} ${verdict.padEnd(8)} "${c.q}" -> ${d.action} ${d.ids.join('+') || '-'} want ${(c.expect ?? [c.kind]).join('/')}`);
        }
        if (d.bridge) rows.push(`  ${model} bridge for "${c.q}": "${d.bridge}"`);
      } catch (e) {
        v.push('wrong');
        rows.push(`  ${model} error "${c.q}": ${String(e)}`);
      }
    }
    summarize(`Claude router (${model})`, v, lat);
  }

  console.log('\nMisses:');
  for (const r of rows) console.log(r);
  const outAt = process.argv.indexOf('--out');
  if (outAt > 0) writeFileSync(process.argv[outAt + 1]!, rows.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
