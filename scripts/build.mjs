// Bundles the app with esbuild: main process, preload, renderer pages, CLI tools.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });

const nodeCommon = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'linked',
  // ws optionally requires these native add-ons; it works without them.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
};

await build({
  ...nodeCommon,
  entryPoints: { 'main/main': 'src/main/main.ts', 'preload/preload': 'src/preload/preload.ts' },
  outdir: dist,
});

await build({
  ...nodeCommon,
  entryPoints: {
    'cli/inspect-sheet': 'src/cli/inspect-sheet.ts',
    'cli/benchmark': 'src/cli/benchmark.ts',
  },
  outdir: dist,
});

const rendererDir = join(root, 'src/renderer');
const pages = readdirSync(rendererDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
await build({
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  sourcemap: 'linked',
  logLevel: 'warning',
  entryPoints: Object.fromEntries(pages.map((f) => [f.replace(/\.ts$/, ''), join(rendererDir, f)])),
  outdir: join(dist, 'renderer'),
});

mkdirSync(join(dist, 'renderer'), { recursive: true });
for (const f of readdirSync(rendererDir)) {
  if (f.endsWith('.html') || f.endsWith('.css')) cpSync(join(rendererDir, f), join(dist, 'renderer', f));
}
console.log('Built to dist/');
