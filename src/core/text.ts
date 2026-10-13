// Small text utilities for matching: tokenizing, light stemming, synonym folding.

const CONTRACTIONS: [RegExp, string][] = [
  [/n['’]t\b/g, ' not'],
  [/['’](s|re|ve|ll|d|m)\b/g, ''],
];

export const STOPWORDS = new Set(
  (
    'a an the and or but so of to in on at for with from by as is are was were be been being am do does did done ' +
    'i me my mine we us our you your yours he him his she her they them their it its this that these those there here ' +
    'what which who whom whose when where why how can could would should will shall may might must ' +
    'tell talk walk share give describe explain example time times about little bit more some any just really ' +
    'um uh like okay ok well yeah yes so right sure great thanks thank alright also kind sort maybe please ' +
    'have has had get got go going went let lets one ever someone something anything make makes made making see saw'
  ).split(/\s+/),
);

/** Canonical forms for words interviewers use interchangeably. Applied after stemming. */
const SYNONYM_GROUPS: string[][] = [
  ['persuad', 'convinc', 'influenc', 'sway', 'persuasion'],
  ['conflict', 'disagre', 'disagreement', 'friction', 'clash', 'disput', 'tension', 'argument'],
  ['fail', 'failur', 'mistak', 'error', 'mess', 'screw'],
  ['stress', 'pressur', 'stressful', 'overwhelm', 'cope'],
  ['priorit', 'prioritiz', 'priority', 'juggl', 'workload', 'multitask'],
  ['delegat', 'delegation'],
  ['motivat', 'motivation', 'inspir', 'driv'],
  ['team', 'teamwork', 'collaborat', 'collaboration', 'group'],
  ['lead', 'leader', 'leadership'],
  ['initiativ', 'proactiv', 'self-start'],
  ['goal', 'target', 'objectiv'],
  ['decid', 'decision', 'choic', 'judgment', 'judgement'],
  ['ethic', 'ethical', 'integrity', 'moral', 'uncomfortabl'],
  ['feedback', 'criticism', 'critiqu', 'constructiv'],
  ['client', 'customer'],
  ['upset', 'angry', 'frustrat', 'unhappy', 'irat', 'difficult'],
  ['present', 'presentation', 'speech'],
  ['writ', 'written', 'memo', 'document'],
  ['problem', 'issu', 'challeng', 'obstacl'],
  ['strength', 'strong'],
  ['weakness', 'weak', 'improv'],
  ['polic', 'rule', 'procedur'],
  ['anticipat', 'forese', 'prevent'],
  ['investigat', 'fact', 'fact-find', 'dig', 'root'],
  ['unpopular', 'controversial'],
  ['fir', 'terminat', 'let go'],
  ['proud', 'proudest', 'accomplishment', 'achievement', 'accomplish'],
  ['organiz', 'organized', 'organis'],
  ['hir', 'choos', 'pick', 'candidat'],
  ['yourself', 'background', 'journey'],
  ['skill', 'abilit'],
];

const CANON = new Map<string, string>();
for (const g of SYNONYM_GROUPS) for (const w of g) CANON.set(w, g[0]!);

export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ly')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function canonical(stemmed: string): string {
  if (CANON.has(stemmed)) return CANON.get(stemmed)!;
  for (const [k, v] of CANON) if (k.length >= 4 && stemmed.startsWith(k)) return v;
  return stemmed;
}

export function words(text: string): string[] {
  let t = text.toLowerCase();
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  return t.match(/[a-z0-9]+(?:\.[a-z0-9]+)*/g) ?? [];
}

/** Content tokens: stopwords removed, stemmed, synonyms folded. */
export function tokens(text: string): string[] {
  return words(text)
    .filter((w) => !STOPWORDS.has(w))
    .map((w) => canonical(stem(w)));
}

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

export const BEHAVIORAL =
  /\b(tell (me|us) about a time|describe (a|an)\b[^.?]{0,40}\b(time|situation|experience)|give (me|us) an example|an example (of|when|where)|walk me through a time|a time (when|where|you)|share (a time|an example)|situation (where|when|in which)|have you ever)\b/i;

/** The interviewer is pointing at the resume. */
export const RESUME = /\b(i see|on your resume|you worked at|you were at|your time at|your (role|job|work|position) at|you list|it says)\b/i;

export const DIRECT = /^(so,?\s+)?(what|why|how|where|when|who|which|do you|are you|would you|have you|is there|can you|could you)\b/i;

export const MORE = /\b(tell me more|say more|go on|what happened (next|then)|elaborate|expand on|walk me through (that|it)|more about (that|it))\b/i;

export const ASK_PROMPT =
  /\b(any questions for (me|us)|questions (do|did) you have|what questions|anything you('d| would) like to ask|anything (you want )?to ask (me|us)|questions for me)\b/i;

const QUESTION_START =
  /^(so,?\s+|and\s+|okay,?\s+|ok,?\s+|great,?\s+|alright,?\s+|now,?\s+)?(tell|what|what's|how|why|can|could|would|do|did|have|describe|give|walk|share|talk|when|where|who|is|are|which|if)\b/i;

/** True when the interviewer is (probably) asking the candidate something, not commenting. */
export function looksLikeQuestion(text: string): boolean {
  if (BEHAVIORAL.test(text) || ASK_PROMPT.test(text) || /\?\s*$/.test(text)) return true;
  return (text.match(/[^.!?]+[.!?]*/g) ?? []).some((s) => QUESTION_START.test(s.trim()));
}

const BACKCHANNEL = /^(ok(ay)?|great|right|sure|yeah|yes|mm+-?hm+|uh-?huh|got it|perfect|nice|cool|wonderful|awesome|thanks?( you)?|makes sense|i see|interesting|wow|good)[.!,]*$/i;

export function isBackchannel(text: string): boolean {
  const t = text.trim();
  return !t || BACKCHANNEL.test(t) || (wordCount(t) <= 2 && !/\?$/.test(t));
}
