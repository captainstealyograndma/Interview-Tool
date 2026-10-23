// Renders script blocks as DOM nodes. Text is set with textContent only.

import type { ScriptBlock } from '../../shared/ipc';

export function renderBlocks(container: HTMLElement, blocks: ScriptBlock[], unmet: string[] = [], labelFor?: (id: string) => string): void {
  for (const block of blocks) {
    const span = document.createElement('span');
    span.className = 'block';
    for (const c of block.chunks) {
      const s = document.createElement('span');
      s.textContent = c.text;
      s.classList.add(c.kind === 'space' ? 'say' : c.kind);
      if (c.bold) s.classList.add('b');
      if (c.italic) s.classList.add('i');
      if (c.backref && unmet.includes(c.backref)) {
        s.classList.add('unmet');
        s.title = `Refers to ${labelFor ? labelFor(c.backref) : c.backref}, which hasn't come up yet`;
      }
      if (c.kind === 'draft' && c.unverified) {
        s.classList.add('unverified');
        s.title = 'Not found in your Sheet or materials';
      }
      span.append(s);
    }
    container.append(span, document.createTextNode(' '));
  }
}
