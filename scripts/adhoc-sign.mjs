// After packaging on a Mac: give the app a local ("ad-hoc") signature so macOS
// can remember the audio-capture permission. No Apple developer account needed.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform !== 'darwin') {
  console.log('Not on macOS; skipping signing.');
  process.exit(0);
}
const release = new URL('../release/', import.meta.url).pathname;
const dirs = existsSync(release) ? readdirSync(release).filter((d) => d.startsWith('mac')) : [];
let signed = 0;
for (const d of dirs) {
  const app = join(release, d, 'Interview Banner.app');
  if (!existsSync(app)) continue;
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`Signed ${app}`);
  signed++;
}
if (!signed) {
  console.error('Could not find release/mac*/Interview Banner.app to sign.');
  process.exit(1);
}
