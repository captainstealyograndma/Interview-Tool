import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSheet } from '../src/core/sheet';

export const FIXTURE = join(__dirname, 'fixtures', 'sample-sheet.docx');
/** Your real Sheet, kept out of git in private/. Tests that need it are skipped when it's absent. */
export const REAL_SHEET = process.env.SHEET_PATH ?? join(__dirname, '..', 'private', 'sheet.docx');
export const hasRealSheet = existsSync(REAL_SHEET);

export async function fixtureSheet() {
  return loadSheet(readFileSync(FIXTURE));
}

export async function realSheet() {
  return loadSheet(readFileSync(REAL_SHEET));
}
