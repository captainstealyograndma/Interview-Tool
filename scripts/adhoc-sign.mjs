// After packaging on a Mac: give the app a local ("ad-hoc") signature so macOS
// can remember the audio-capture permission. No Apple developer account needed.
//
// Plain ad-hoc signatures change with every build, and macOS ties the
// "Screen & System Audio Recording" permission to the signature, so an updated
// app shows as allowed but is silently refused. To keep the permission across
// updates, the outer app is re-signed with a designated requirement based on
// its bundle identifier instead of the build's hash.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const APP_FILE = 'Interview Banner 2.app';
const BUNDLE_ID = 'com.interviewbanner.app2';

if (process.platform !== 'darwin') {
  console.log('Not on macOS; skipping signing.');
  process.exit(0);
}
const release = new URL('../release/', import.meta.url).pathname;
const dirs = existsSync(release) ? readdirSync(release).filter((d) => d.startsWith('mac')) : [];
let signed = 0;
for (const d of dirs) {
  const app = join(release, d, APP_FILE);
  if (!existsSync(app)) continue;
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  try {
    execFileSync('codesign', ['--force', '--sign', '-', '--requirements', `=designated => identifier "${BUNDLE_ID}"`, app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log(`Signed ${app} with a stable identity (${BUNDLE_ID}).`);
  } catch {
    // Fall back to the plain ad-hoc signature; macOS will ask for the permission again after updates.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    console.log(`Signed ${app} (plain ad-hoc).`);
  }
  signed++;
}
if (!signed) {
  console.error(`Could not find release/mac*/${APP_FILE} to sign.`);
  process.exit(1);
}
