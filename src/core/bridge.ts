// Lead-in ("bridge") validation. A bridge may only use words from the
// interviewer's question, the script it leads into, or plain connecting words.
// Anything else (a new name, number, fact or claim) and the bridge is dropped.

import { words } from './text';

const MAX_WORDS = 15;

const CONNECTORS = new Set(
  (
    'a an the and but so or that this these those it its is was were be been i im id ive my me we our us you your ' +
    'yes yeah sure absolutely definitely of course good great question one example examples comes come to mind from ' +
    'time times when where what how which of for in on at with about think would say like actually well honestly ' +
    'really best probably there thats its heres here lets let start share happy talk tell walk through good situation ' +
    'experience something thing case story moment way kind sort first then also too do does did as by if not no ' +
    'point closest come comes came back clear clearest strongest favorite recent recently right now goes went'
  ).split(/\s+/),
);

export function validateBridge(bridge: string, question: string, scriptText: string): string | null {
  const b = bridge.trim();
  if (!b) return null;
  const bw = words(b);
  if (bw.length === 0 || bw.length > MAX_WORDS) return null;
  const allowed = new Set([...words(question), ...words(scriptText)]);
  for (const w of bw) {
    if (!allowed.has(w) && !CONNECTORS.has(w)) return null;
  }
  if (/[0-9]/.test(b)) {
    for (const n of b.match(/[0-9][0-9,.]*/g) ?? []) if (!question.includes(n) && !scriptText.includes(n)) return null;
  }
  return b;
}
