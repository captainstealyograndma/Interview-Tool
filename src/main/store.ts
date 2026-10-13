// Settings, API keys (encrypted with the macOS Keychain via safeStorage),
// and per-Sheet review state, all under the app's userData folder.

import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouterModel } from '../core/router';
import type { Pairing } from '../core/types';

interface StoredSettings {
  model: RouterModel;
  fontSize: number;
  lastSheetPath?: string;
  anthropicKey?: string; // base64 of safeStorage-encrypted bytes
  deepgramKey?: string;
  bannerBounds?: Electron.Rectangle;
  trayBounds?: Electron.Rectangle;
}

export interface ReviewState {
  approved: boolean;
  pairings: Record<string, Pairing>;
  phrasings?: Record<string, string[]>;
}

const DEFAULT_SETTINGS: StoredSettings = { model: 'claude-opus-5-5', fontSize: 28 };

function dir(...parts: string[]): string {
  const d = join(app.getPath('userData'), ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? { ...fallback, ...JSON.parse(readFileSync(file, 'utf8')) } : fallback;
  } catch {
    return fallback;
  }
}

export class Store {
  private file = join(dir(), 'settings.json');
  private data: StoredSettings = readJson(this.file, DEFAULT_SETTINGS);

  get settings(): StoredSettings {
    return this.data;
  }

  update(patch: Partial<StoredSettings>): void {
    this.data = { ...this.data, ...patch };
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  setKey(name: 'anthropicKey' | 'deepgramKey', value: string): void {
    const v = value.trim();
    if (!v) {
      this.update({ [name]: undefined });
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure key storage is not available on this Mac.');
    this.update({ [name]: safeStorage.encryptString(v).toString('base64') });
  }

  getKey(name: 'anthropicKey' | 'deepgramKey'): string {
    const enc = this.data[name];
    if (!enc) return process.env[name === 'anthropicKey' ? 'ANTHROPIC_API_KEY' : 'DEEPGRAM_API_KEY'] ?? '';
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return '';
    }
  }

  review(hash: string): ReviewState {
    return readJson(join(dir('reviews'), `${hash}.json`), { approved: false, pairings: {} } as ReviewState);
  }

  saveReview(hash: string, state: ReviewState): void {
    writeFileSync(join(dir('reviews'), `${hash}.json`), JSON.stringify(state, null, 2));
  }
}
