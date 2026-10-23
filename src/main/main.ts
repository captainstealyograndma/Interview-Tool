// Electron main process for Interview Banner 2: windows, IPC, profiles and the live session.

import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, screen, session as electronSession, shell } from 'electron';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { renderCatalog } from '../core/catalog';
import { ClaudeDrafter } from '../core/drafter';
import { Engine } from '../core/engine';
import { Matcher } from '../core/matcher';
import { loadMaterial, materialKeyterms, materialsBlock, MATERIAL_LABEL, type MaterialKind, type Materials } from '../core/materials';
import { applySavedPairings, buildReview, editPairing } from '../core/review';
import { ClaudeRouter, generatePhrasings } from '../core/router';
import { loadSheet } from '../core/sheet';
import { FluxTranscriber } from '../core/stt/deepgram';
import type { Sheet } from '../core/types';
import { verifySheet, type VerbatimReport } from '../core/verbatim';
import type { MaterialStatus, ProfileView, SessionState, Settings, SheetSummary } from '../shared/ipc';
import { fileStamp, Store, type Profile } from './store';

const APP_NAME = 'Interview Banner 2';
const V1_APP_NAME = 'Interview Banner';

let store: Store;
let home: BrowserWindow | null = null;
let review: BrowserWindow | null = null;
let banner: BrowserWindow | null = null;
let tray: BrowserWindow | null = null;

// Active profile's loaded state
let sheet: Sheet | undefined;
let report: VerbatimReport | undefined;
let sheetError: string | undefined;
let materials: Materials = {};
let materialErrors: Partial<Record<MaterialKind, string>> = {};
let phrasingStatus: string | undefined;

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

// ---------------------------------------------------------------- settings

function settings(): Settings {
  const s = store.settings;
  return { model: s.model, fontSize: s.fontSize, hasAnthropicKey: !!store.getKey('anthropicKey'), hasDeepgramKey: !!store.getKey('deepgramKey') };
}

// ---------------------------------------------------------------- profile: sheet + materials

function summary(): SheetSummary | null {
  const profile = store.activeProfile;
  if (!sheet || !profile?.sheetPath || !report) return null;
  const r = store.review(sheet.hash);
  const pieces = Object.values(sheet.pieces);
  return {
    path: profile.sheetPath,
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

function materialStatuses(profile: Profile | undefined): MaterialStatus[] {
  return (['resume', 'cover', 'posting'] as MaterialKind[]).map((kind) => {
    const path = profile?.[`${kind}Path` as const];
    const m = materials[kind];
    return {
      kind,
      ...(path ? { path, fileName: basename(path) } : {}),
      ...(m ? { words: m.words } : {}),
      ...(materialErrors[kind] ? { error: materialErrors[kind] } : {}),
    };
  });
}

function profileView(): ProfileView {
  const active = store.activeProfile;
  return {
    profiles: store.profiles.map((p) => ({ id: p.id, name: p.name, active: p.id === active?.id })),
    ...(active ? { active: { id: active.id, name: active.name, active: true } } : {}),
    sheet: summary(),
    ...(sheetError ? { sheetError } : {}),
    materials: materialStatuses(active),
    ...(phrasingStatus ? { phrasingStatus } : {}),
  };
}

function pushProfile() {
  broadcast('profile', profileView());
}

async function loadActiveSheet(): Promise<void> {
  sheet = undefined;
  report = undefined;
  sheetError = undefined;
  const path = store.activeProfile?.sheetPath;
  if (!path) return;
  try {
    const { sheet: s, documentXml } = await loadSheet(readFileSync(path));
    report = verifySheet(s, documentXml);
    applySavedPairings(s, store.review(s.hash).pairings);
    sheet = s;
  } catch (e) {
    sheetError = existsSync(path) ? `Could not read the Sheet: ${(e as Error).message}` : `The Sheet file is missing: ${path}`;
  }
}

async function loadActiveMaterials(): Promise<void> {
  materials = {};
  materialErrors = {};
  const profile = store.activeProfile;
  if (!profile) return;
  const cache = store.materialsCache(profile.id);
  let changed = false;
  for (const kind of ['resume', 'cover', 'posting'] as MaterialKind[]) {
    const path = profile[`${kind}Path` as const];
    if (!path) continue;
    const stamp = fileStamp(path);
    const cached = cache.materials[kind];
    if (cached && cached.path === path && cache.stamps[path] === stamp) {
      materials[kind] = cached;
      continue;
    }
    try {
      materials[kind] = await loadMaterial(kind, path, readFileSync(path));
      cache.materials[kind] = materials[kind];
      cache.stamps[path] = stamp;
      changed = true;
    } catch (e) {
      materialErrors[kind] = existsSync(path) ? (e as Error).message : 'File is missing';
    }
  }
  for (const kind of Object.keys(cache.materials) as MaterialKind[]) {
    if (!profile[`${kind}Path` as const]) {
      delete cache.materials[kind];
      changed = true;
    }
  }
  if (changed) store.saveMaterialsCache(profile.id, cache);
}

async function activateProfile(): Promise<ProfileView> {
  stopSession();
  await loadActiveSheet();
  await loadActiveMaterials();
  pushProfile();
  return profileView();
}

// ---------------------------------------------------------------- phrasings (automatic at approval)

async function runPhrasings(hash: string): Promise<void> {
  const apiKey = store.getKey('anthropicKey');
  if (!sheet || !apiKey || sheet.hash !== hash) return;
  const s = sheet;
  phrasingStatus = 'Learning question phrasings…';
  pushProfile();
  try {
    const phrasings = await generatePhrasings(s, { apiKey, model: store.settings.model }, (done, total) => {
      phrasingStatus = `Learning question phrasings… ${done}/${total}`;
      pushProfile();
    });
    store.saveReview(hash, { ...store.review(hash), phrasings });
    phrasingStatus = undefined;
  } catch (e) {
    phrasingStatus = `Couldn't learn phrasings (${(e as Error).message}). The Sheet still works; approve again to retry.`;
  }
  pushProfile();
}

// ---------------------------------------------------------------- windows

function createHome() {
  home = new BrowserWindow({ width: 1000, height: 900, title: APP_NAME, webPreferences: webPrefs() });
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
    title: APP_NAME,
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
  if (!sheet) return { ...sessionState, message: sheetError ?? 'Choose your Sheet first.' };
  if (!report?.ok) return { ...sessionState, message: 'This Sheet failed the word-for-word check; it cannot be used.' };
  if (!store.review(sheet.hash).approved) return { ...sessionState, message: 'Review and approve your Sheet first.' };
  stopSession();

  const reviewState = store.review(sheet.hash);
  const anthropicKey = store.getKey('anthropicKey');
  const deepgramKey = store.getKey('deepgramKey');
  const model = store.settings.model;
  const router = anthropicKey ? new ClaudeRouter(sheet, { apiKey: anthropicKey, model }) : null;
  const drafter = anthropicKey ? new ClaudeDrafter(sheet, materials, { apiKey: anthropicKey, model }) : null;
  const knownText = [renderCatalog(sheet), materialsBlock(materials)].join('\n');
  engine = new Engine(sheet, new Matcher(sheet, reviewState.phrasings ?? {}), router, {}, drafter ? { drafter, knownText } : null);
  engine.on('banner', (v) => {
    broadcast('banner', v);
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

  if (router) router.warm().catch((e) => broadcast('status', { ...engine?.statusView, routerState: 'error', message: `Claude: ${String(e.message ?? e)}` }));
  if (drafter) drafter.warm().catch(() => undefined);

  if (deepgramKey) {
    const keyterms = [...sheet.keyterms, ...materialKeyterms(materials)].filter((t, i, a) => a.indexOf(t) === i).slice(0, 40);
    flux = new FluxTranscriber({ apiKey: deepgramKey, keyterms });
    flux.on('turn', (ev) => engine?.handle(ev));
    flux.on('open', () => setSession({ listening: true, message: undefined }));
    flux.on('close', () => setSession({ listening: false }));
    flux.on('error', (e: Error) => setSession({ message: e.message }));
    flux.start();
  }
  setSession({ running: true, listening: false, message: deepgramKey ? undefined : 'No Deepgram key: listening is off. Test mode still works.' });
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

async function pickFile(title: string, filters: Electron.FileFilter[]): Promise<string | undefined> {
  const res = await dialog.showOpenDialog(home!, { title, properties: ['openFile'], filters });
  return res.canceled ? undefined : res.filePaths[0];
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Pick<Settings, 'model' | 'fontSize'>>) => {
    const clean: Partial<Settings> = {};
    if (patch.model === 'claude-opus-5-5' || patch.model === 'claude-haiku-5-5') clean.model = patch.model;
    if (typeof patch.fontSize === 'number') clean.fontSize = Math.max(16, Math.min(56, Math.round(patch.fontSize)));
    store.update(clean);
    if (clean.fontSize && banner && !banner.isDestroyed()) banner.setBounds({ ...banner.getBounds(), height: bannerHeight(clean.fontSize) });
    broadcast('settings', settings());
    return settings();
  });
  ipcMain.handle('keys:set', (_e, keys: { anthropic?: string; deepgram?: string }) => {
    if (keys.anthropic !== undefined) store.setKey('anthropicKey', keys.anthropic);
    if (keys.deepgram !== undefined) store.setKey('deepgramKey', keys.deepgram);
    return settings();
  });

  ipcMain.handle('profile:get', () => profileView());
  ipcMain.handle('profile:create', async (_e, name: string) => {
    store.createProfile(String(name));
    return activateProfile();
  });
  ipcMain.handle('profile:rename', (_e, name: string) => {
    const p = store.activeProfile;
    if (p && String(name).trim()) store.updateProfile(p.id, { name: String(name).trim() });
    pushProfile();
    return profileView();
  });
  ipcMain.handle('profile:delete', async () => {
    const p = store.activeProfile;
    if (p) store.deleteProfile(p.id);
    return activateProfile();
  });
  ipcMain.handle('profile:select', async (_e, id: string) => {
    store.selectProfile(String(id));
    return activateProfile();
  });
  ipcMain.handle('sheet:choose', async () => {
    const p = store.activeProfile ?? store.createProfile('My interview');
    const path = await pickFile('Choose your Sheet', [{ name: 'Word document', extensions: ['docx'] }]);
    if (!path) return profileView();
    store.updateProfile(p.id, { sheetPath: path });
    if (p.name === 'My interview' || p.name === 'New interview') store.updateProfile(p.id, { name: basename(path).replace(/\.docx$/i, '') });
    return activateProfile();
  });
  ipcMain.handle('sheet:reload', () => activateProfile());
  ipcMain.handle('material:choose', async (_e, kind: MaterialKind) => {
    const p = store.activeProfile;
    if (!p || !MATERIAL_LABEL[kind]) return profileView();
    const path = await pickFile(`Choose your ${MATERIAL_LABEL[kind].toLowerCase()}`, [{ name: 'Word, PDF or text', extensions: ['docx', 'pdf', 'txt', 'md'] }]);
    if (!path) return profileView();
    store.updateProfile(p.id, { [`${kind}Path`]: path });
    await loadActiveMaterials();
    pushProfile();
    return profileView();
  });
  ipcMain.handle('material:clear', async (_e, kind: MaterialKind) => {
    const p = store.activeProfile;
    if (!p || !MATERIAL_LABEL[kind]) return profileView();
    store.updateProfile(p.id, { [`${kind}Path`]: undefined });
    await loadActiveMaterials();
    pushProfile();
    return profileView();
  });
  ipcMain.handle('template:save', async () => {
    const src = join(app.getAppPath(), 'templates', 'Interview Prep Sheet Template.docx');
    if (!existsSync(src)) throw new Error('The template is missing from this installation.');
    const res = await dialog.showSaveDialog(home!, { title: 'Save a blank Sheet template', defaultPath: join(app.getPath('documents'), 'Interview Prep Sheet Template.docx') });
    if (res.canceled || !res.filePath) return null;
    copyFileSync(src, res.filePath);
    return res.filePath;
  });

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
    pushProfile();
    return buildReview(sheet, summary()!);
  });
  ipcMain.handle('review:approve', () => {
    if (!sheet || !report?.ok) return summary();
    const r = store.review(sheet.hash);
    store.saveReview(sheet.hash, { ...r, approved: true });
    pushProfile();
    if (!r.phrasings || !Object.keys(r.phrasings).length) void runPhrasings(sheet.hash);
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

// Keep this app's data apart from the original Interview Banner.
app.setName(APP_NAME);
app.setPath('userData', join(dirname(app.getPath('userData')), APP_NAME));

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
  });
  store.importFromV1(join(dirname(app.getPath('userData')), V1_APP_NAME));
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

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e) => e.preventDefault());
  });

  await loadActiveSheet();
  await loadActiveMaterials();
  createHome();
});

app.on('window-all-closed', () => app.quit());
