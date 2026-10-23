// Settings, API keys (encrypted with the macOS Keychain via safeStorage),
// interview profiles, cached material text, and per-Sheet review state.
// Everything lives under this app's own userData folder, separate from
// the original Interview Banner.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Materials } from '../core/materials';
import type { RouterModel } from '../core/router';
import type { Pairing } from '../core/types';

export interface Profile {
  id: string;
  name: string;
  sheetPath?: string;
  resumePath?: string;
  coverPath?: string;
  postingPath?: string;
  createdAt: number;
}

interface StoredSettings {
  model: RouterModel;
  fontSize: number;
  anthropicKey?: string; // base64 of safeStorage-encrypted bytes
  deepgramKey?: string;
  bannerBounds?: Electron.Rectangle;
  trayBounds?: Electron.Rectangle;
  profiles: Profile[];
  activeProfile?: string;
  importedFromV1?: boolean;
}

export interface ReviewState {
  approved: boolean;
  pairings: Record<string, Pairing>;
  phrasings?: Record<string, string[]>;
}

export interface MaterialsCache {
  materials: Materials;
  /** path -> "size:mtime" at extraction time */
  stamps: Record<string, string>;
}

export interface Crypto {
  available(): boolean;
  encrypt(s: string): string;
  decrypt(s: string): string;
}

const DEFAULT_SETTINGS: StoredSettings = { model: 'claude-haiku-5-5', fontSize: 28, profiles: [] };

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? { ...fallback, ...JSON.parse(readFileSync(file, 'utf8')) } : fallback;
  } catch {
    return fallback;
  }
}

export function fileStamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

export class Store {
  private file: string;
  private data: StoredSettings;

  constructor(
    private base: string,
    private crypto: Crypto,
  ) {
    mkdirSync(base, { recursive: true });
    this.file = join(base, 'settings.json');
    this.data = readJson(this.file, DEFAULT_SETTINGS);
    if (!['claude-opus-5-5', 'claude-haiku-5-5'].includes(this.data.model)) this.data.model = DEFAULT_SETTINGS.model;
  }

  private dir(...parts: string[]): string {
    const d = join(this.base, ...parts);
    mkdirSync(d, { recursive: true });
    return d;
  }

  get settings(): StoredSettings {
    return this.data;
  }

  update(patch: Partial<StoredSettings>): void {
    this.data = { ...this.data, ...patch };
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  // ---------------------------------------------------------------- keys

  setKey(name: 'anthropicKey' | 'deepgramKey', value: string): void {
    const v = value.trim();
    if (!v) {
      this.update({ [name]: undefined });
      return;
    }
    if (!this.crypto.available()) throw new Error('Secure key storage is not available on this Mac.');
    this.update({ [name]: this.crypto.encrypt(v) });
  }

  getKey(name: 'anthropicKey' | 'deepgramKey'): string {
    const enc = this.data[name];
    if (!enc) return process.env[name === 'anthropicKey' ? 'ANTHROPIC_API_KEY' : 'DEEPGRAM_API_KEY'] ?? '';
    try {
      return this.crypto.decrypt(enc);
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------- profiles

  get profiles(): Profile[] {
    return this.data.profiles;
  }

  get activeProfile(): Profile | undefined {
    return this.data.profiles.find((p) => p.id === this.data.activeProfile) ?? this.data.profiles[0];
  }

  createProfile(name: string): Profile {
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const profile: Profile = { id, name: name.trim() || 'New interview', createdAt: Date.now() };
    this.update({ profiles: [...this.data.profiles, profile], activeProfile: id });
    return profile;
  }

  updateProfile(id: string, patch: Partial<Omit<Profile, 'id' | 'createdAt'>>): Profile | undefined {
    const profiles = this.data.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p));
    this.update({ profiles });
    return profiles.find((p) => p.id === id);
  }

  deleteProfile(id: string): void {
    const profiles = this.data.profiles.filter((p) => p.id !== id);
    const activeProfile = this.data.activeProfile === id ? profiles[0]?.id : this.data.activeProfile;
    this.update({ profiles, ...(activeProfile !== undefined ? { activeProfile } : { activeProfile: undefined }) });
  }

  selectProfile(id: string): void {
    if (this.data.profiles.some((p) => p.id === id)) this.update({ activeProfile: id });
  }

  // ---------------------------------------------------------------- materials cache

  materialsCache(profileId: string): MaterialsCache {
    return readJson(join(this.dir('materials'), `${profileId}.json`), { materials: {}, stamps: {} } as MaterialsCache);
  }

  saveMaterialsCache(profileId: string, cache: MaterialsCache): void {
    writeFileSync(join(this.dir('materials'), `${profileId}.json`), JSON.stringify(cache));
  }

  // ---------------------------------------------------------------- reviews

  review(hash: string): ReviewState {
    return readJson(join(this.dir('reviews'), `${hash}.json`), { approved: false, pairings: {} } as ReviewState);
  }

  saveReview(hash: string, state: ReviewState): void {
    writeFileSync(join(this.dir('reviews'), `${hash}.json`), JSON.stringify(state, null, 2));
  }

  // ---------------------------------------------------------------- first run

  /**
   * On first run, carries over the original Interview Banner's settings, Sheet and
   * review approvals. API keys cannot be carried over: macOS keeps each app's
   * encrypted keys separate.
   */
  importFromV1(v1Dir: string): { imported: boolean; sheetPath?: string } {
    if (this.data.importedFromV1 || this.data.profiles.length) return { imported: false };
    const v1Settings = join(v1Dir, 'settings.json');
    if (!existsSync(v1Settings)) {
      this.update({ importedFromV1: true });
      return { imported: false };
    }
    const v1 = readJson<{ model?: RouterModel; fontSize?: number; lastSheetPath?: string; bannerBounds?: Electron.Rectangle; trayBounds?: Electron.Rectangle }>(
      v1Settings,
      {},
    );
    const patch: Partial<StoredSettings> = { importedFromV1: true };
    if (typeof v1.fontSize === 'number') patch.fontSize = v1.fontSize;
    if (v1.bannerBounds) patch.bannerBounds = v1.bannerBounds;
    if (v1.trayBounds) patch.trayBounds = v1.trayBounds;
    this.update(patch);
    const v1Reviews = join(v1Dir, 'reviews');
    if (existsSync(v1Reviews)) {
      for (const f of readdirSync(v1Reviews)) {
        const dest = join(this.dir('reviews'), f);
        if (!existsSync(dest)) copyFileSync(join(v1Reviews, f), dest);
      }
    }
    let sheetPath: string | undefined;
    if (v1.lastSheetPath && existsSync(v1.lastSheetPath)) {
      sheetPath = v1.lastSheetPath;
      const profile = this.createProfile(basename(sheetPath).replace(/\.docx$/i, ''));
      this.updateProfile(profile.id, { sheetPath });
    }
    return { imported: true, ...(sheetPath ? { sheetPath } : {}) };
  }
}
