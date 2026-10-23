import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store, type Crypto } from '../src/main/store';

const fakeCrypto: Crypto = {
  available: () => true,
  encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString().replace(/^enc:/, ''),
};

function tmp() {
  return mkdtempSync(join(tmpdir(), 'ib2-'));
}

describe('Store: profiles, keys, first-run import', () => {
  it('stores keys encrypted and reads them back', () => {
    const dir = tmp();
    const store = new Store(dir, fakeCrypto);
    store.setKey('anthropicKey', 'sk-ant-test');
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).anthropicKey).not.toContain('sk-ant-test');
    expect(store.getKey('anthropicKey')).toBe('sk-ant-test');
    expect(new Store(dir, fakeCrypto).getKey('anthropicKey')).toBe('sk-ant-test');
  });

  it('creates, selects, updates and deletes interview profiles', () => {
    const store = new Store(tmp(), fakeCrypto);
    const a = store.createProfile('Firm A');
    const b = store.createProfile('Firm B');
    expect(store.activeProfile?.id).toBe(b.id);
    store.selectProfile(a.id);
    expect(store.activeProfile?.name).toBe('Firm A');
    store.updateProfile(a.id, { sheetPath: '/x/sheet.docx', resumePath: '/x/resume.pdf' });
    expect(store.activeProfile?.resumePath).toBe('/x/resume.pdf');
    store.updateProfile(a.id, { resumePath: undefined });
    expect(store.activeProfile?.resumePath).toBeUndefined();
    store.deleteProfile(a.id);
    expect(store.profiles.map((p) => p.name)).toEqual(['Firm B']);
    expect(store.activeProfile?.id).toBe(b.id);
  });

  it('defaults to the fastest model and keeps review state per Sheet', () => {
    const store = new Store(tmp(), fakeCrypto);
    expect(store.settings.model).toBe('claude-haiku-5-5');
    store.saveReview('abc', { approved: true, pairings: {} });
    expect(store.review('abc').approved).toBe(true);
    expect(store.review('other').approved).toBe(false);
  });

  it('carries over the original app\'s Sheet, font size and approvals on first run, but not its keys', () => {
    const root = tmp();
    const v1 = join(root, 'Interview Banner');
    const v2 = join(root, 'Interview Banner 2');
    mkdirSync(join(v1, 'reviews'), { recursive: true });
    const sheetPath = join(root, 'My Sheet.docx');
    writeFileSync(sheetPath, 'not really a docx');
    writeFileSync(join(v1, 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5', fontSize: 34, lastSheetPath: sheetPath, anthropicKey: 'ZW5jOnYxa2V5' }));
    writeFileSync(join(v1, 'reviews', 'h1.json'), JSON.stringify({ approved: true, pairings: {} }));

    const store = new Store(v2, fakeCrypto);
    const result = store.importFromV1(v1);
    expect(result).toEqual({ imported: true, sheetPath });
    expect(store.settings.fontSize).toBe(34);
    expect(store.settings.model).toBe('claude-haiku-5-5'); // v2 default, not v1's choice
    expect(store.getKey('anthropicKey')).toBe('');
    expect(store.activeProfile?.name).toBe('My Sheet');
    expect(store.activeProfile?.sheetPath).toBe(sheetPath);
    expect(existsSync(join(v2, 'reviews', 'h1.json'))).toBe(true);
    // Only once.
    expect(new Store(v2, fakeCrypto).importFromV1(v1).imported).toBe(false);
  });
});
