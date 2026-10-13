import type { Api, TrayView } from '../shared/ipc';

declare global {
  interface Window {
    api: Api;
  }
}

const list = document.getElementById('list')!;
const asked = new Set<string>();

function item(key: string, text: string, tag: string, cls: string) {
  const d = document.createElement('div');
  d.className = `q ${cls}${asked.has(key) ? ' asked' : ''}`;
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = tag;
  d.append(t, document.createTextNode(text));
  d.addEventListener('click', () => {
    if (asked.has(key)) asked.delete(key);
    else asked.add(key);
    d.classList.toggle('asked');
  });
  return d;
}

function render(v: TrayView) {
  list.replaceChildren();
  for (const s of v.suggestions) list.append(item(`s:${s}`, s, 'Suggested', 'suggested'));
  if (v.suggestions.length) {
    const hr = document.createElement('div');
    hr.className = 'divider';
    list.append(hr);
  }
  // The closing question (e.g. "To close") stays last.
  const closers = v.sheetQuestions.filter((q) => q.note && /close|last|end/i.test(q.note));
  const rest = v.sheetQuestions.filter((q) => !closers.includes(q));
  for (const q of rest) list.append(item(q.id, q.text, 'Sheet', 'sheet'));
  for (const q of closers) list.append(item(q.id, q.text, q.note ?? 'Close', 'sheet closer'));
}

window.api.on('tray', (v) => v && render(v as TrayView));
