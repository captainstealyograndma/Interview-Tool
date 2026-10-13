import type { Api, SessionState, Settings, SheetSummary, StatusView } from '../shared/ipc';

declare global {
  interface Window {
    api: Api;
  }
}

const api = window.api;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let summary: SheetSummary | null = null;
let session: SessionState = { running: false, listening: false };

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

// ---------------------------------------------------------------- sheet

function renderSummary(s: SheetSummary | null) {
  summary = s;
  const info = $('sheetInfo');
  info.replaceChildren();
  if (!s) {
    info.textContent = 'No Sheet loaded.';
    return;
  }
  const title = document.createElement('div');
  title.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = s.title;
  title.append(b);
  const check = document.createElement('span');
  check.className = `pill ${s.verified ? 'ok' : 'bad'}`;
  check.textContent = s.verified ? 'word-for-word check passed' : 'word-for-word check FAILED';
  const approved = document.createElement('span');
  approved.className = `pill ${s.approved ? 'ok' : 'warn'}`;
  approved.textContent = s.approved ? 'approved' : 'needs review';
  const counts = document.createElement('div');
  counts.textContent = `${s.pieces} pieces · ${s.stories} stories · ${s.finder} Question Finder entries`;
  const row = document.createElement('div');
  row.className = 'row';
  row.append(check, approved);
  info.append(title, row, counts);
  for (const p of [...s.problems, ...s.warnings]) {
    const d = document.createElement('div');
    d.className = 'msg';
    d.textContent = p;
    info.append(d);
  }
  $('phrasingsState').textContent = s.phrasings ? `${s.phrasings} pieces have extra phrasings` : '';
}

$('openSheet').addEventListener('click', async () => {
  try {
    renderSummary(await api.openSheet());
    $('sheetMsg').textContent = '';
  } catch (e) {
    $('sheetMsg').textContent = `Could not read that file: ${(e as Error).message}`;
  }
});
$('reloadSheet').addEventListener('click', async () => renderSummary(await api.reloadSheet()));
$('review').addEventListener('click', () => api.openReview());
$('phrasings').addEventListener('click', async () => {
  $('phrasingsState').textContent = 'Working…';
  try {
    renderSummary(await api.generatePhrasings());
  } catch (e) {
    $('phrasingsState').textContent = (e as Error).message;
  }
});
api.on('progress', (p) => {
  const { done, total } = p as { done: number; total: number };
  $('phrasingsState').textContent = `Working… ${done}/${total}`;
});
api.on('sheet', (s) => renderSummary(s as SheetSummary));

// ---------------------------------------------------------------- audio capture

let audioCtx: AudioContext | undefined;
let stream: MediaStream | undefined;
let silentSince = 0;

async function startAudio(): Promise<void> {
  stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 320, height: 240, frameRate: 1 } });
  // The screen track is required by the API; it is never used.
  for (const t of stream.getVideoTracks()) t.enabled = false;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) throw new Error('macOS did not provide call audio. Check Screen & System Audio Recording permission.');
  audioCtx = new AudioContext(); // the worklet resamples to 16 kHz
  await audioCtx.audioWorklet.addModule('audio-worklet.js');
  const source = audioCtx.createMediaStreamSource(new MediaStream(audioTracks));
  const node = new AudioWorkletNode(audioCtx, 'pcm-capture');
  const mute = audioCtx.createGain();
  mute.gain.value = 0; // keeps the graph running without playing anything
  source.connect(node).connect(mute).connect(audioCtx.destination);
  silentSince = Date.now();
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    api.sendAudio(e.data.pcm);
    api.audioLevel(e.data.rms);
    $('meter').style.width = `${Math.min(100, Math.round(Math.sqrt(e.data.rms) * 300))}%`;
    if (e.data.rms > 0.002) silentSince = Date.now();
    else if (Date.now() - silentSince > 20000) {
      $('sessionMsg').textContent =
        'No call audio for 20 seconds. If someone is talking, open System Settings → Privacy & Security → Screen & System Audio Recording and allow Interview Banner, then restart it.';
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
  if (!summary?.approved) {
    $('sessionMsg').textContent = 'Review and approve your Sheet first.';
    return;
  }
  // Ask macOS for the call audio first, while this click still counts as a user action.
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
  if (!summary?.approved) {
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
  else if (data && msg === 'instant') line += `  "${data.question}"`;
  else if (data) line += `  ${JSON.stringify(data).slice(0, 160)}`;
  const log = $('log');
  log.textContent = `${line}\n${log.textContent ?? ''}`.slice(0, 8000);
});

void (async () => {
  renderSettings(await api.getSettings());
  renderSummary(await api.getSummary());
  renderSession(session);
})();
