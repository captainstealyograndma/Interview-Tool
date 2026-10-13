// Types shared between the main process and the windows.

import type { BannerView, StatusView, TrayView } from '../core/engine';
import type { RouterModel } from '../core/router';
import type { ScriptBlock } from '../core/script';

export type { BannerView, StatusView, TrayView, RouterModel, ScriptBlock };

export interface Settings {
  model: RouterModel;
  fontSize: number;
  hasAnthropicKey: boolean;
  hasDeepgramKey: boolean;
  lastSheetPath?: string;
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
  /** What the banner will show for this entry. */
  preview: ScriptBlock[];
  /** The story the entry points to, with its paragraphs, for editing. */
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
  openSheet(): Promise<SheetSummary | null>;
  reloadSheet(): Promise<SheetSummary | null>;
  getSummary(): Promise<SheetSummary | null>;
  openReview(): Promise<void>;
  getReview(): Promise<ReviewData | null>;
  setPairing(finder: string, blocks: number[] | null): Promise<ReviewData | null>;
  approve(): Promise<SheetSummary | null>;
  generatePhrasings(): Promise<SheetSummary | null>;
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
  on(channel: 'banner' | 'tray' | 'status' | 'session' | 'log' | 'level' | 'progress' | 'settings' | 'sheet', cb: (data: unknown) => void): () => void;
}
