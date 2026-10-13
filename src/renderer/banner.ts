import type { Api, BannerView, Settings, StatusView } from '../shared/ipc';
import { renderBlocks } from './lib/chunks';

declare global {
  interface Window {
    api: Api;
  }
}

const api = window.api;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const root = $('banner');
const scroller = $('scroller');
const script = $('script');
const bar = $('bar');

let current: BannerView | undefined;
let fontSize = 28;
let programmaticScroll = false;
let lastScrollSent = 0;

function setFont(px: number) {
  fontSize = px;
  document.documentElement.style.setProperty('--fs', `${px}px`);
}

function updateProgress() {
  const max = scroller.scrollHeight - scroller.clientHeight;
  // The script has two blank lines of padding at the end so the last line can scroll up to the top.
  const pct = max > 0 ? Math.min(1, scroller.scrollTop / Math.max(1, max - fontSize * 1.35 * 2)) : 0;
  bar.style.width = `${Math.round(pct * 100)}%`;
}

function sourceText(v: BannerView): string {
  if (v.mode === 'idle') return '';
  if (v.source === 'claude') return v.latencyMs ? `Claude · ${(v.latencyMs / 1000).toFixed(1)}s` : 'Claude';
  if (v.source === 'offline') return 'instant match (Claude unavailable)';
  if (v.source === 'manual') return 'chosen by you';
  return 'instant match';
}

function render(v: BannerView) {
  const isNewScript =
    !current || current.turn !== v.turn || current.mode !== v.mode || current.blocks[0]?.piece !== v.blocks[0]?.piece || current.label !== v.label;
  current = v;
  root.dataset.mode = v.mode;
  $('state').textContent = v.mode === 'provisional' ? 'listening · likely' : v.mode === 'not-in-sheet' ? 'NOT IN SHEET' : '';
  $('label').textContent = v.mode === 'not-in-sheet' ? '' : v.label;
  $('cue').textContent = v.cues.join('  ·  ');
  $('source').textContent = sourceText(v);
  const ru = $<HTMLButtonElement>('runnerup');
  ru.hidden = !v.runnerUp;
  ru.textContent = v.runnerUp ? `↺ ${v.runnerUp.label}` : '';
  ru.title = v.runnerUp ? `Show instead: ${v.runnerUp.label}` : '';

  script.replaceChildren();
  if (v.mode === 'idle') {
    const s = document.createElement('span');
    s.className = 'idle-text';
    s.textContent = 'Waiting for the next question…';
    script.append(s);
  } else if (v.mode === 'not-in-sheet') {
    if (!v.closest.length) {
      const s = document.createElement('span');
      s.className = 'idle-text';
      s.textContent = 'Your Sheet has nothing close to this question.';
      script.append(s);
    }
    for (const c of v.closest) {
      const l = document.createElement('span');
      l.className = 'closest-label';
      l.textContent = `Closest: ${c.label}`;
      script.append(l);
      renderBlocks(script, c.blocks);
    }
  } else {
    renderBlocks(script, v.blocks, v.unmetBackrefs);
  }
  if (isNewScript) {
    programmaticScroll = true;
    scroller.scrollTop = 0;
    requestAnimationFrame(() => (programmaticScroll = false));
  }
  updateProgress();
}

scroller.addEventListener('scroll', () => {
  updateProgress();
  if (programmaticScroll) return;
  const now = Date.now();
  if (now - lastScrollSent > 200) {
    lastScrollSent = now;
    api.bannerScrolled();
  }
});

$('runnerup').addEventListener('click', () => api.showRunnerUp());
$('smaller').addEventListener('click', () => api.setSettings({ fontSize: fontSize - 2 }));
$('larger').addEventListener('click', () => api.setSettings({ fontSize: fontSize + 2 }));
$('hide').addEventListener('click', () => api.closeBanner());

api.on('banner', (v) => v && render(v as BannerView));
api.on('settings', (s) => setFont((s as Settings).fontSize));
api.on('status', (s) => {
  const st = s as StatusView;
  if (st.routerState === 'error' && current?.mode !== 'idle') $('source').textContent = 'instant match (Claude unavailable)';
});
api.on('level', (rms) => {
  const level = Math.min(1, Math.sqrt(Number(rms)) * 3);
  $('meterfill').style.width = `${Math.round(level * 100)}%`;
});

void api.getSettings().then((s) => setFont(s.fontSize));
render({ mode: 'idle', source: 'instant', label: '', cues: [], blocks: [], closest: [], unmetBackrefs: [], question: '', turn: -1, version: 0 });
