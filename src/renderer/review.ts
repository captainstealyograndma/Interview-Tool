import type { Api, ReviewData, ReviewPairing, ReviewPiece } from '../shared/ipc';
import { renderBlocks } from './lib/chunks';

declare global {
  interface Window {
    api: Api;
  }
}

const api = window.api;
const $ = (id: string) => document.getElementById(id)!;
let data: ReviewData | null = null;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderHeader(d: ReviewData) {
  $('title').textContent = d.summary.title;
  const check = $('check');
  check.textContent = d.summary.verified ? 'word-for-word check passed' : 'word-for-word check FAILED';
  check.className = `pill ${d.summary.verified ? 'ok' : 'bad'}`;
  const ap = $('approved');
  ap.textContent = d.summary.approved ? 'approved' : 'not approved yet';
  ap.className = `pill ${d.summary.approved ? 'ok' : 'warn'}`;
  ($('approve') as HTMLButtonElement).disabled = !d.summary.verified || d.summary.approved;
}

function pairingCard(p: ReviewPairing): HTMLElement {
  const card = h('div', 'card');
  const head = h('div', 'row');
  head.append(h('span', 'pill', p.finder), h('b', '', p.title));
  if (p.edited) head.append(h('span', 'pill warn', 'edited'));
  card.append(head);
  if (p.instruction) card.append(h('p', 'muted', `Your Sheet says: ${p.instruction}`));
  const preview = h('div', 'preview');
  renderBlocks(preview, p.preview);
  card.append(h('div', 'muted', 'The banner will show:'), preview);
  if (p.target && p.target.paragraphs.length > 1) {
    const paras = h('div', 'paras');
    paras.append(h('div', 'muted', `Paragraphs of ${p.target.label} to include:`));
    for (const para of p.target.paragraphs) {
      const label = h('label');
      const box = h('input');
      box.type = 'checkbox';
      box.checked = para.selected;
      box.dataset.index = String(para.index);
      label.append(box, h('span', '', para.text));
      paras.append(label);
    }
    paras.addEventListener('change', async () => {
      const chosen = [...paras.querySelectorAll<HTMLInputElement>('input:checked')].map((b) => Number(b.dataset.index));
      data = await api.setPairing(p.finder, chosen);
      if (data) render(data, 'pairings');
    });
    card.append(paras);
    if (p.edited) {
      const reset = h('button', '', 'Reset to what the Sheet says');
      reset.addEventListener('click', async () => {
        data = await api.setPairing(p.finder, null);
        if (data) render(data, 'pairings');
      });
      card.append(reset);
    }
  }
  return card;
}

function pieceView(p: ReviewPiece): HTMLElement {
  const el = h('div', 'piece');
  const head = h('div');
  head.append(h('span', 'id', p.id), h('span', 'title', p.title));
  el.append(head);
  if (p.prompts.length) el.append(h('div', 'prompts', `Matches: ${p.prompts.join(' · ')}`));
  for (const block of p.blocks) {
    if (!block.length) continue;
    const para = h('p');
    for (const s of block) {
      para.append(h('span', `seg-${s.kind}`, s.text), document.createTextNode(' '));
    }
    el.append(para);
  }
  if (p.links.length) el.append(h('div', 'links', `Points to: ${p.links.join(' · ')}`));
  if (p.children.length) {
    const kids = h('div', 'children');
    for (const c of p.children) kids.append(pieceView(c));
    el.append(kids);
  }
  return el;
}

function render(d: ReviewData, keepTab?: string) {
  renderHeader(d);
  const pairings = $('tab-pairings');
  pairings.replaceChildren(
    h('p', 'muted', 'Each Question Finder entry shows its opening line, then the part of the story your Sheet names. Check each one.'),
    ...d.pairings.map(pairingCard),
  );

  const backrefs = $('tab-backrefs');
  backrefs.replaceChildren(
    h('p', 'muted', 'These phrases refer to something you may not have said yet. During the interview they get a faint underline until that story has been shown.'),
  );
  const list = h('div', 'card');
  if (!d.backrefs.length) list.append(h('p', 'muted', 'None found.'));
  for (const b of d.backrefs) list.append(h('p', '', `${b.piece}: "${b.phrase}" — refers to ${b.targetLabel}`));
  backrefs.append(list);

  const pieces = $('tab-pieces');
  pieces.replaceChildren();
  for (const s of d.sections) {
    const card = h('div', 'card');
    card.append(h('h2', '', s.title));
    for (const r of s.rules) card.append(h('p', 'muted', `Guidance: ${r}`));
    for (const p of s.pieces) card.append(pieceView(p));
    pieces.append(card);
  }
  if (keepTab) showTab(keepTab);
}

function showTab(name: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>('nav.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of ['pairings', 'backrefs', 'pieces']) ($(`tab-${t}`) as HTMLElement).hidden = t !== name;
}

for (const b of document.querySelectorAll<HTMLButtonElement>('nav.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab!));

$('approve').addEventListener('click', async () => {
  const s = await api.approve();
  if (data && s) {
    data = { ...data, summary: s };
    renderHeader(data);
  }
});

void (async () => {
  data = await api.getReview();
  if (data) render(data);
  else $('title').textContent = 'Open a Sheet first';
})();
