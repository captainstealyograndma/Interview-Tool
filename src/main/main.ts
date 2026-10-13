// Electron main process: windows, IPC, and the live session.

import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session as electronSession, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../core/engine';
import { Matcher } from '../core/matcher';
import { applySavedPairings, buildReview, editPairing } from '../core/review';
import { ClaudeRouter, generatePhrasings } from '../core/router';
import { loadSheet } from '../core/sheet';
import { FluxTranscriber } from '../core/stt/deepgram';
import type { Sheet } from '../core/types';
import { verifySheet, type VerbatimReport } from '../core/verbatim';
import type { SessionState, Settings, SheetSummary } from '../shared/ipc';
import { Store } from './store';

let store: Store;
let home: BrowserWindow | null = null;
let review: BrowserWindow | null = null;
let banner: BrowserWindow | null = null;
let tray: BrowserWindow | null = null;

let sheetPath: string | undefined;
let sheet: Sheet | undefined;
let report: VerbatimReport | undefined;

let engine: Engine | undefined;
let flux: FluxTranscriber | undefined;
let sessionState: SessionState = { running: false, listening: false };

const renderer = (page: string) => join(__dirname, '..', 'renderer', page);
const preload = join(__dirname, '..', 'preload', 'preload.js');

function webPrefs(): Electron.WebPreferences {
  return { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false };
}

function broadcast(channel: string, data: unknown) {
  for (const w of [home, review, banner, tray]) if (w && !w.isDestroyed()) w.webContents.send(channel, data);
}

// ---------------------------------------------------------------- settings / sheet

function settings(): Settings {
  const s = store.settings;
  return {
    model: s.model,
    fontSize: s.fontSize,
    hasAnthropicKey: !!store.getKey('anthropicKey'),
    hasDeepgramKey: !!store.getKey('deepgramKey'),
    ...(s.lastSheetPath ? { lastSheetPath: s.lastSheetPath } : {}),
  };
}

function summary(): SheetSummary | null {
  if (!sheet || !sheetPath || !report) return null;
  const r = store.review(sheet.hash);
  const pieces = Object.values(sheet.pieces);
  return {
    path: sheetPath,
    title: sheet.title,
    hash: sheet.hash,
    pieces: pieces.length,
    stories: pieces.filter((p) => p.kind === 'story').length,
    finder: pieces.filter((p) => p.kind === 'finder').length,
    verified: report.ok,
    problems: report.problems,
    warnings: sheet.warnings,
    approved: r.approved,
    phrasings: Object.keys(r.phrasings ?? {}).length,
  };
}

async function load(path: string): Promise<SheetSummary | null> {
  const { sheet: s, documentXml } = await loadSheet(readFileSync(path));
  report = verifySheet(s, documentXml);
  applySavedPairings(s, store.review(s.hash).pairings);
  sheet = s;
  sheetPath = path;
  store.update({ lastSheetPath: path });
  return summary();
}

// ---------------------------------------------------------------- windows

function createHome() {
  home = new BrowserWindow({ width: 980, height: 820, title: 'Interview Banner', webPreferences: webPrefs() });
  home.loadFile(renderer('home.html'));
  home.on('closed', () => {
    home = null;
    stopSession();
    app.quit();
  });
}

function openReview() {
  if (review && !review.isDestroyed()) return review.focus();
  review = new BrowserWindow({ width: 1180, height: 900, title: 'Review your Sheet', webPreferences: webPrefs() });
  review.loadFile(renderer('review.html'));
  review.on('closed', () => (review = null));
}

function bannerHeight(fontSize: number) {
  // label line + 3 lines of text + progress bar + padding
  return Math.round(30 + fontSize * 1.35 * 3 + 6 + 12);
}

function openBanner() {
  if (banner && !banner.isDestroyed()) return banner.showInactive();
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.round(Math.min(1400, area.width * 0.72));
  const saved = store.settings.bannerBounds;
  banner = new BrowserWindow({
    x: saved?.x ?? Math.round(area.x + (area.width - width) / 2),
    y: saved?.y ?? area.y + 4,
    width: saved?.width ?? width,
    height: saved?.height ?? bannerHeight(store.settings.fontSize),
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: true,
    skipTaskbar: true,
    title: 'Interview Banner',
    webPreferences: webPrefs(),
  });
  banner.setAlwaysOnTop(true, 'screen-saver');
  banner.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  banner.loadFile(renderer('banner.html'));
  const save = () => banner && !banner.isDestroyed() && store.update({ bannerBounds: banner.getBounds() });
  banner.on('moved', save);
  banner.on('resized', save);
  banner.on('closed', () => (banner = null));
}

function openTray() {
  if (tray && !tray.isDestroyed()) return tray.showInactive();
  const area = screen.getPrimaryDisplay().workArea;
  const saved = store.settings.trayBounds;
  tray = new BrowserWindow({
    x: saved?.x ?? area.x + area.width - 380,
    y: saved?.y ?? area.y + 220,
    width: saved?.width ?? 360,
    height: saved?.height ?? 320,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Questions to ask',
    webPreferences: webPrefs(),
  });
  tray.setAlwaysOnTop(true, 'screen-saver');
  tray.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  tray.loadFile(renderer('tray.html'));
  const save = () => tray && !tray.isDestroyed() && store.update({ trayBounds: tray.getBounds() });
  tray.on('moved', save);
  tray.on('resized', save);
  tray.on('closed', () => (tray = null));
}

// ---------------------------------------------------------------- session

function setSession(patch: Partial<SessionState>) {
  sessionState = { ...sessionState, ...patch };
  broadcast('session', sessionState);
}

async function startSession(): Promise<SessionState> {
  if (!sheet) return { ...sessionState, message: 'Load your Sheet first.' };
  if (!report?.ok) return { ...sessionState, message: 'This Sheet failed the word-for-word check; it cannot be used.' };
  if (!store.review(sheet.hash).approved) return { ...sessionState, message: 'Review and approve your Sheet first.' };
  stopSession();

  const reviewState = store.review(sheet.hash);
  const anthropicKey = store.getKey('anthropicKey');
  const deepgramKey = store.getKey('deepgramKey');
  const router = anthropicKey ? new ClaudeRouter(sheet, { apiKey: anthropicKey, model: store.settings.model }) : null;
  engine = new Engine(sheet, new Matcher(sheet, reviewState.phrasings ?? {}), router);
  engine.on('banner', (v) => {
    broadcast('banner', v);
    // A hidden banner comes back for the next question.
    if (v.mode !== 'idle' && banner && !banner.isDestroyed() && !banner.isVisible()) banner.showInactive();
  });
  engine.on('tray', (v) => broadcast('tray', v));
  engine.on('status', (v) => broadcast('status', v));
  engine.on('log', (v) => broadcast('log', v));

  openBanner();
  openTray();
  setTimeout(() => {
    broadcast('banner', engine?.banner);
    broadcast('tray', engine?.trayView);
    broadcast('status', engine?.statusView);
    broadcast('settings', settings());
  }, 400);

  if (router) {
    router.warm().catch((e) => broadcast('status', { ...engine?.statusView, routerState: 'error', message: `Claude: ${String(e.message ?? e)}` }));
  }

  if (deepgramKey) {
    flux = new FluxTranscriber({ apiKey: deepgramKey, keyterms: sheet.keyterms });
    flux.on('turn', (ev) => engine?.handle(ev));
    flux.on('open', () => setSession({ listening: true, message: undefined }));
    flux.on('close', () => setSession({ listening: false }));
    flux.on('error', (e: Error) => setSession({ message: e.message }));
    flux.start();
  }
  setSession({
    running: true,
    listening: false,
    message: deepgramKey ? undefined : 'No Deepgram key: listening is off. Test mode still works.',
  });
  return sessionState;
}

function stopSession(): SessionState {
  flux?.stop();
  flux = undefined;
  engine?.removeAllListeners();
  engine = undefined;
  for (const w of [banner, tray]) if (w && !w.isDestroyed()) w.close();
  setSession({ running: false, listening: false });
  return sessionState;
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('settings:get', () => settings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Pick<Settings, 'model' | 'fontSize'>>) => {
    const clean: Partial<Settings> = {};
    if (patch.model === 'claude-opus-5-5' || patch.model === 'claude-haiku-5-5') clean.model = patch.model;
    if (typeof patch.fontSize === 'number') clean.fontSize = Math.max(16, Math.min(56, Math.round(patch.fontSize)));
    store.update(clean);
    if (clean.fontSize && banner && !banner.isDestroyed()) {
      const b = banner.getBounds();
      banner.setBounds({ ...b, height: bannerHeight(clean.fontSize) });
    }
    broadcast('settings', settings());
    return settings();
  });
  ipcMain.handle('keys:set', (_e, keys: { anthropic?: string; deepgram?: string }) => {
    if (keys.anthropic !== undefined) store.setKey('anthropicKey', keys.anthropic);
    if (keys.deepgram !== undefined) store.setKey('deepgramKey', keys.deepgram);
    return settings();
  });
  ipcMain.handle('sheet:open', async () => {
    const res = await dialog.showOpenDialog(home!, { properties: ['openFile'], filters: [{ name: 'Word document', extensions: ['docx'] }] });
    if (res.canceled || !res.filePaths[0]) return summary();
    return load(res.filePaths[0]);
  });
  ipcMain.handle('sheet:reload', async () => (sheetPath ? load(sheetPath) : summary()));
  ipcMain.handle('sheet:summary', () => summary());
  ipcMain.handle('review:open', () => openReview());
  ipcMain.handle('review:get', () => {
    const s = summary();
    return sheet && s ? buildReview(sheet, s) : null;
  });
  ipcMain.handle('review:setPairing', (_e, finder: string, blocks: number[] | null) => {
    if (!sheet) return null;
    sheet.pairings[finder] = editPairing(sheet, finder, blocks);
    const r = store.review(sheet.hash);
    const pairings = { ...r.pairings };
    if (blocks === null) delete pairings[finder];
    else pairings[finder] = sheet.pairings[finder]!;
    store.saveReview(sheet.hash, { ...r, pairings, approved: false });
    const s = summary()!;
    broadcast('sheet', s);
    return buildReview(sheet, s);
  });
  ipcMain.handle('review:approve', () => {
    if (!sheet || !report?.ok) return summary();
    store.saveReview(sheet.hash, { ...store.review(sheet.hash), approved: true });
    return summary();
  });
  ipcMain.handle('phrasings:generate', async () => {
    if (!sheet) return summary();
    const apiKey = store.getKey('anthropicKey');
    if (!apiKey) throw new Error('Add your Anthropic API key first.');
    const phrasings = await generatePhrasings(sheet, { apiKey, model: store.settings.model }, (done, total) =>
      broadcast('progress', { done, total }),
    );
    store.saveReview(sheet.hash, { ...store.review(sheet.hash), phrasings });
    return summary();
  });
  ipcMain.handle('session:start', () => startSession());
  ipcMain.handle('session:stop', () => stopSession());
  ipcMain.handle('session:simulate', async (_e, text: string) => {
    if (!engine) await startSession();
    await engine?.simulate(String(text));
  });
  ipcMain.on('audio:chunk', (_e, pcm: ArrayBuffer) => flux?.send(Buffer.from(pcm)));
  ipcMain.on('audio:level', (_e, rms: number) => {
    if (banner && !banner.isDestroyed()) banner.webContents.send('level', rms);
  });
  ipcMain.on('audio:error', (_e, message: string) => setSession({ message }));
  ipcMain.on('banner:scrolled', () => engine?.userScrolled());
  ipcMain.on('banner:runnerUp', () => engine?.showRunnerUp());
  ipcMain.on('banner:showPiece', (_e, id: string) => engine?.showPiece(id));
  ipcMain.on('banner:close', () => banner?.hide());
}

// ---------------------------------------------------------------- app

app.whenReady().then(async () => {
  store = new Store();
  registerIpc();

  // System audio (the call) via Core Audio tap. The video track is required by the API and ignored.
  electronSession.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  // Links in the app open in the browser, never inside the app.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e) => e.preventDefault());
  });

  if (store.settings.lastSheetPath) {
    try {
      await load(store.settings.lastSheetPath);
    } catch {
      /* file moved; the user can open it again */
    }
  }
  createHome();
});

app.on('window-all-closed', () => app.quit());
