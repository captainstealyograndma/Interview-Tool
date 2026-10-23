import type { Api, MaterialKind, ProfileView, SessionState, Settings, SheetSummary, StatusView } from '../shared/ipc';

declare global {
  interface Window {
    api: Api;
  }
}

const api = window.api;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let profile: ProfileView = { profiles: [], sheet: null, materials: [] };
let session: SessionState = { running: false, listening: false };

const MATERIAL_LABELS: Record<MaterialKind, string> = { resume: 'Resume', cover: 'Cover letter', posting: 'Job posting' };

// ---------------------------------------------------------------- settings & keys

function pill(el: HTMLElement, text: string, cls: '' | 'ok' | 'warn' | 'bad') {
  el.textContent = text;
  el.className = `pill ${cls}`;
}

function renderSettings(s: Settings) {
  settings = s;
  pill($('anthropicState'), s.hasAnthropicKey ? 'saved' : 'not set', s.hasAnthropicKey ? 'ok' : 'warn');
  pill($('deepgramState'), s.hasDeepgramKey ? 'saved' : 'not set', s.hasDeepgramKey ? 'ok' : 'warn');
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=model]')) r.checked = r.value === s.model;
}

$('saveAnthropic').addEventListener('click', async () => {
  renderSettings(await api.setKeys({ anthropic: $<HTMLInputElement>('anthropic').value }));
  $<HTMLInputElement>('anthropic').value = '';
});
$('saveDeepgram').addEventListener('click', async () => {
  renderSettings(await api.setKeys({ deepgram: $<HTMLInputElement>('deepgram').value }));
  $<HTMLInputElement>('deepgram').value = '';
});
for (const r of document.querySelectorAll<HTMLInputElement>('input[name=model]')) {
  r.addEventListener('change', async () => renderSettings(await api.setSettings({ model: r.value as Settings['model'] })));
}

// ---------------------------------------------------------------- profile: sheet + materials

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderSheet(s: SheetSummary | null, error?: string) {
  const info = $('sheetInfo');
  info.replaceChildren();
  if (error) {
    info.append(el('div', 'msg', error));
    return;
  }
  if (!s) {
    info.textContent = 'No Sheet chosen.';
    return;
  }
  const title = el('div');
  title.append(el('b', '', s.title));
  const row = el('div', 'row');
  row.append(
    el('span', `pill ${s.verified ? 'ok' : 'bad'}`, s.verified ? 'word-for-word check passed' : 'word-for-word check FAILED'),
    el('span', `pill ${s.approved ? 'ok' : 'warn'}`, s.approved ? 'approved' : 'needs review'),
  );
  info.append(title, row, el('div', '', `${s.pieces} pieces · ${s.stories} stories · ${s.finder} Question Finder entries`));
  for (const p of [...s.problems, ...s.warnings]) info.append(el('div', 'msg', p));
}

function renderMaterials(v: ProfileView) {
  const box = $('materials');
  box.replaceChildren();
  for (const m of v.materials) {
    const row = el('div', 'row');
    const label = el('span', 'mat-label', MATERIAL_LABELS[m.kind]);
    const status = el('span', m.error ? 'msg' : 'muted', m.error ? `${m.fileName ?? ''}: ${m.error}` : m.fileName ? `${m.fileName} · ${m.words ?? 0} words` : 'none');
    const choose = el('button', '', m.path ? 'Change…' : 'Choose…');
    choose.addEventListener('click', async () => renderProfile(await api.chooseMaterial(m.kind)));
    row.append(label, status, choose);
    if (m.path) {
      const clear = el('button', '', 'Remove');
      clear.addEventListener('click', async () => renderProfile(await api.clearMaterial(m.kind)));
      row.append(clear);
    }
    box.append(row);
  }
}

function renderProfile(v: ProfileView) {
  profile = v;
  const select = $<HTMLSelectElement>('profileSelect');
  select.replaceChildren();
  if (!v.profiles.length) {
    const o = el('option', '', 'No interview yet. Click "New interview…"');
    o.value = '';
    select.append(o);
  }
  for (const p of v.profiles) {
    const o = el('option', '', p.name);
    o.value = p.id;
    o.selected = p.active;
    select.append(o);
  }
  const hasProfile = !!v.active;
  for (const id of ['renameProfile', 'deleteProfile', 'chooseSheet', 'reloadSheet', 'review']) $<HTMLButtonElement>(id).disabled = !hasProfile;
  renderSheet(v.sheet, v.sheetError);
  $('phrasingState').textContent = v.phrasingStatus ?? (v.sheet?.phrasings ? `Knows ${v.sheet.phrasings} items' alternative phrasings.` : '');
  renderMaterials(v);
}

$('profileSelect').addEventListener('change', async () => {
  const id = $<HTMLSelectElement>('profileSelect').value;
  if (id) renderProfile(await api.selectProfile(id));
});
$('newProfile').addEventListener('click', () => {
  $('newProfileRow').hidden = false;
  $<HTMLInputElement>('newProfileName').focus();
});
$('cancelProfile').addEventListener('click', () => ($('newProfileRow').hidden = true));
async function createProfile() {
  const name = $<HTMLInputElement>('newProfileName').value.trim();
  if (!name) return;
  renderProfile(await api.createProfile(name));
  $<HTMLInputElement>('newProfileName').value = '';
  $('newProfileRow').hidden = true;
}
$('createProfile').addEventListener('click', () => void createProfile());
$('newProfileName').addEventListener('keydown', (e) => e.key === 'Enter' && void createProfile());
$('renameProfile').addEventListener('click', async () => {
  const name = window.prompt('New name for this interview:', profile.active?.name ?? '');
  if (name && name.trim()) renderProfile(await api.renameProfile(name.trim()));
});
$('deleteProfile').addEventListener('click', async () => {
  if (!profile.active) return;
  if (window.confirm(`Delete the interview "${profile.active.name}"? Your files are not deleted, only this app's record of them.`)) {
    renderProfile(await api.deleteProfile());
  }
});
$('chooseSheet').addEventListener('click', async () => {
  try {
    renderProfile(await api.chooseSheet());
    $('sheetMsg').textContent = '';
  } catch (e) {
    $('sheetMsg').textContent = `Could not read that file: ${(e as Error).message}`;
  }
});
$('reloadSheet').addEventListener('click', async () => renderProfile(await api.reloadSheet()));
$('review').addEventListener('click', () => api.openReview());
$('template').addEventListener('click', async () => {
  try {
    const path = await api.saveTemplate();
    if (path) $('sheetMsg').textContent = `Saved the template to ${path}`;
  } catch (e) {
    $('sheetMsg').textContent = (e as Error).message;
  }
});
api.on('profile', (v) => renderProfile(v as ProfileView));

// ---------------------------------------------------------------- audio capture

let audioCtx: AudioContext | undefined;
let stream: MediaStream | undefined;
let silentSince = 0;

async function startAudio(): Promise<void> {
  stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 320, height: 240, frameRate: 1 } });
  for (const t of stream.getVideoTracks()) t.enabled = false;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    throw new Error(
      'macOS did not provide call audio. Open System Settings → Privacy & Security → Screen & System Audio Recording. If Interview Banner 2 is already listed as allowed, select it, click the − button to remove it, then click Start listening again and Allow.',
    );
  }
  audioCtx = new AudioContext(); // the worklet resamples to 16 kHz
  await audioCtx.audioWorklet.addModule('audio-worklet.js');
  const source = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
  const node = new AudioWorkletNode(audioCtx, 'pcm-capture');
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(audioCtx.destination);
  silentSince = Date.now();
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    api.sendAudio(e.data.pcm);
    api.audioLevel(e.data.rms);
    $('meter').style.width = `${Math.min(100, Math.round(Math.sqrt(e.data.rms) * 300))}%`;
    if (e.data.rms > 0.002) silentSince = Date.now();
    else if (Date.now() - silentSince > 20000) {
      $('sessionMsg').textContent =
        'No call audio for 20 seconds. If someone is talking: open System Settings → Privacy & Security → Screen & System Audio Recording. If Interview Banner 2 is listed as allowed, select it and click − to remove it; then Stop, Start listening again, and Allow.';
      silentSince = Date.now();
    }
  };
}

function stopAudio() {
  for (const t of stream?.getTracks() ?? []) t.stop();
  void audioCtx?.close();
  audioCtx = undefined;
  stream = undefined;
  $('meter').style.width = '0';
}

// ---------------------------------------------------------------- session

function renderSession(s: SessionState) {
  session = s;
  pill($('listenState'), s.listening ? 'listening' : s.running ? 'running (not listening)' : 'stopped', s.listening ? 'ok' : s.running ? 'warn' : '');
  $('sessionMsg').textContent = s.message ?? '';
  $<HTMLButtonElement>('start').disabled = s.running;
  $<HTMLButtonElement>('stop').disabled = !s.running;
}

$('start').addEventListener('click', async () => {
  $('sessionMsg').textContent = '';
  if (!profile.sheet?.approved) {
    $('sessionMsg').textContent = 'Review and approve your Sheet first.';
    return;
  }
  if (settings.hasDeepgramKey) {
    try {
      await startAudio();
    } catch (e) {
      $('sessionMsg').textContent = `Couldn't capture call audio: ${(e as Error).message}`;
      api.audioError(String((e as Error).message));
    }
  }
  const s = await api.startSession();
  renderSession(s);
  if (!s.running) stopAudio();
});
$('stop').addEventListener('click', async () => {
  stopAudio();
  renderSession(await api.stopSession());
});

async function ask() {
  const q = $<HTMLInputElement>('testq').value.trim();
  if (!q) return;
  if (!profile.sheet?.approved) {
    $('sessionMsg').textContent = 'Review and approve your Sheet first.';
    return;
  }
  await api.simulate(q);
  $<HTMLInputElement>('testq').select();
}
$('ask').addEventListener('click', () => void ask());
$('testq').addEventListener('keydown', (e) => e.key === 'Enter' && void ask());

api.on('session', (s) => renderSession(s as SessionState));
api.on('status', (s) => {
  const st = s as StatusView;
  $('transcript').textContent = st.transcript;
  pill(
    $('routerState'),
    st.routerState === 'off' ? 'Claude off (no key)' : st.routerState === 'ok' ? `Claude ok${st.lastLatencyMs ? ` · ${(st.lastLatencyMs / 1000).toFixed(1)}s` : ''}` : 'Claude unavailable',
    st.routerState === 'ok' ? 'ok' : st.routerState === 'off' ? '' : 'bad',
  );
  if (st.message) $('sessionMsg').textContent = st.message;
});
api.on('log', (entry) => {
  const { at, msg, data } = entry as { at: number; msg: string; data?: Record<string, unknown> };
  const time = new Date(at).toLocaleTimeString();
  let line = `${time}  ${msg}`;
  if (data && msg === 'decision') line += `  "${data.question}" → ${data.action} ${(data.ids as string[]).join('+')} (${data.latencyMs} ms)`;
  else if (data && (msg === 'instant' || msg === 'draft-start')) line += `  "${data.question}"`;
  else if (data) line += `  ${JSON.stringify(data).slice(0, 160)}`;
  const log = $('log');
  log.textContent = `${line}\n${log.textContent ?? ''}`.slice(0, 8000);
});

void (async () => {
  renderSettings(await api.getSettings());
  renderProfile(await api.getProfile());
  renderSession(session);
})();
