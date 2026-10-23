// Types shared between the main process and the windows.

import type { BannerView, StatusView, TrayView } from '../core/engine';
import type { MaterialKind } from '../core/materials';
import type { RouterModel } from '../core/router';
import type { ScriptBlock } from '../core/script';

export type { BannerView, StatusView, TrayView, RouterModel, ScriptBlock, MaterialKind };

export interface Settings {
  model: RouterModel;
  fontSize: number;
  hasAnthropicKey: boolean;
  hasDeepgramKey: boolean;
}

export interface ProfileSummary {
  id: string;
  name: string;
  active: boolean;
}

export interface MaterialStatus {
  kind: MaterialKind;
  path?: string;
  fileName?: string;
  words?: number;
  error?: string;
}

export interface SheetSummary {
  path: string;
  title: string;
  hash: string;
  pieces: number;
  stories: number;
  finder: number;
  verified: boolean;
  problems: string[];
  warnings: string[];
  approved: boolean;
  phrasings: number;
}

/** Everything the main window shows for the active interview. */
export interface ProfileView {
  profiles: ProfileSummary[];
  active?: ProfileSummary;
  sheet: SheetSummary | null;
  sheetError?: string;
  materials: MaterialStatus[];
  /** Phrasing generation in progress ("12/150") or a short status. */
  phrasingStatus?: string;
}

export interface ReviewSegment {
  text: string;
  kind: 'say' | 'label' | 'note' | 'condition' | 'title';
}

export interface ReviewPiece {
  id: string;
  kind: string;
  title: string;
  prompts: string[];
  blocks: ReviewSegment[][];
  links: string[];
  children: ReviewPiece[];
}

export interface ReviewPairing {
  finder: string;
  title: string;
  edited: boolean;
  preview: ScriptBlock[];
  target?: { id: string; label: string; paragraphs: { index: number; text: string; selected: boolean }[] };
  instruction: string;
}

export interface ReviewData {
  summary: SheetSummary;
  sections: { title: string; kind: string; rules: string[]; pieces: ReviewPiece[] }[];
  pairings: ReviewPairing[];
  backrefs: { piece: string; phrase: string; target: string; targetLabel: string }[];
}

export interface SessionState {
  running: boolean;
  listening: boolean;
  message?: string;
}

export interface Api {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Pick<Settings, 'model' | 'fontSize'>>): Promise<Settings>;
  setKeys(keys: { anthropic?: string; deepgram?: string }): Promise<Settings>;

  getProfile(): Promise<ProfileView>;
  createProfile(name: string): Promise<ProfileView>;
  renameProfile(name: string): Promise<ProfileView>;
  deleteProfile(): Promise<ProfileView>;
  selectProfile(id: string): Promise<ProfileView>;
  chooseSheet(): Promise<ProfileView>;
  reloadSheet(): Promise<ProfileView>;
  chooseMaterial(kind: MaterialKind): Promise<ProfileView>;
  clearMaterial(kind: MaterialKind): Promise<ProfileView>;
  saveTemplate(): Promise<string | null>;

  openReview(): Promise<void>;
  getReview(): Promise<ReviewData | null>;
  setPairing(finder: string, blocks: number[] | null): Promise<ReviewData | null>;
  approve(): Promise<SheetSummary | null>;

  startSession(): Promise<SessionState>;
  stopSession(): Promise<SessionState>;
  simulate(text: string): Promise<void>;
  sendAudio(pcm: ArrayBuffer): void;
  audioLevel(rms: number): void;
  audioError(message: string): void;
  bannerScrolled(): void;
  showRunnerUp(): void;
  showPiece(id: string): void;
  closeBanner(): void;
  on(channel: 'banner' | 'tray' | 'status' | 'session' | 'log' | 'level' | 'settings' | 'profile', cb: (data: unknown) => void): () => void;
}
