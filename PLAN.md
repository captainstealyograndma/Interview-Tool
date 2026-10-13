# Interview Banner: Plan

Status: **approved and built.** Steps 1–3 of the build order are done and tested; steps 4–5 are written and need your Mac to test. See the README for setup.

## 1. What the tool is

A teleprompter for live interviews. It listens to the interviewer on a Teams or Zoom call. It works out which part of your interview prep document (the Sheet) the question calls for. It then shows that text, word for word, in a banner at the top of your screen near the camera.

The Sheet is the only source of answers. The tool never changes what the Sheet says.

### What the AI is allowed to do, and nothing else

1. **Pick the text.** Decide which part or parts of the Sheet answer what was asked.
2. **Combine pieces, only when needed.** Put several pieces of the Sheet together, but only when the question or the Sheet's own instructions call for it. One example is "Open with this line, then tell Story 3."
3. **Write a short lead-in, rarely.** This happens only when no script has an opening that fits the question as asked. The lead-in must flow into the unchanged script.
4. **Suggest questions to ask.** Now and then, in a separate area, suggest a question based on what the interviewer said.

The AI never answers on its own, never invents anecdotes, and never rewords, shortens or edits the Sheet.

## 2. Decisions made

| Topic | Decision |
|---|---|
| Platform | Mac (macOS Tahoe). Teams or Zoom calls on the Mac. Phone interviews are out of scope. |
| Where the text comes from | Your Sheet only, word for word. The AI returns references to pieces of the Sheet, never the text itself. |
| Banner size | About 3 lines of large text. Ordinary line wrapping, with no extra breaks added for breathing. |
| Scrolling | You scroll by hand with the trackpad. |
| What follows an answer | Nothing is lined up in advance. The tool answers exactly what was asked. "Tell me more" is matched like any other question, using the conversation so far. |
| Combining pieces | Only when the question or the Sheet's instructions call for it. |
| When the Sheet doesn't cover a question | A clear "Not in Sheet" flag, plus the closest related material labeled as closest. |
| Speed vs. privacy | Fastest possible, which means cloud transcription and Claude. |
| Questions to ask | A small separate area, available at any time. |
| Load-time review | Yes. You check how the Sheet was split up before the interview. |
| Starting a story partway in | **No.** Stories are never trimmed to avoid repeating the opening line. A story starts at its beginning, or at the point the Sheet itself names (for example, "the second half of Story 11"). You approve that point at load time. |
| "Situation: / Task: / Action: / Result:" labels | **Kept.** They're shown as they appear in the Sheet, in bold. |
| Lines that assume you already said something | The words stay exactly as written. The phrase gets a faint underline when the story it refers to hasn't been shown yet in this interview, so you can decide in the moment. |
| Lead-ins | Rare. Shown in a different color, about 15 words at most. A lead-in is automatically thrown out if it contains any name, number or claim that isn't in the question or your script. |

## 3. How it works

### 3.1 Loading a Sheet (before the interview)

1. **Drop in the Word file.** The tool splits it into numbered pieces and keeps the Sheet's bold and italics. The pieces are:
   - each Core Narrative answer, including any "If they ask…" sub-answer;
   - each story, kept paragraph by paragraph so the Sheet's "first half" and "second half" can be pointed to;
   - each story's likely follow-ups, as question-and-answer pairs;
   - each Question Finder entry, split into its opening line or full answer and its instructions (which story, which part, what to focus on, backups);
   - each Resume Walkthrough line and its linked story;
   - each Classic and Tough question answer;
   - each technical talking point;
   - each question to ask;
   - the Cheat Sheet, which is used only for matching and is never shown as a script.
2. **Exact-text check.** Every piece must match the Word file character for character, or loading fails.
3. **Separate the words you say from your notes.** Notes include "Use it for:" lines, "(Story 1.)", "spend most of your time on…", "(More: …)" and section instructions. Notes are used for matching and show up as a small cue above the text. They are never shown as words to say.
4. **Find back-references.** The tool finds lines that refer to something you may not have said yet, such as an answer that mentions a story "I told you about". It records which story each one depends on, for the faint underline.
5. **Set up Question Finder pairings ahead of time.** For each entry, you see exactly what the banner will show: the opening line, followed by the named story or the named part of it. You approve each one.
6. **Review screen.** You check the pieces, the pairings and the back-references, then press Start.

The Sheet's own matching rules come first. These are the Question Finder, the "Use it for" lines, the Cheat Sheet's "Reach for it when they ask about" column, and section notes such as "Use these only if the interviewer goes technical". You already decided which story fits which question, and the tool applies your decisions.

### 3.2 Listening

- The tool captures **only the call audio** (the sound coming out of your Mac), not your microphone, so you reading aloud never confuses it. It uses macOS's built-in system-audio capture, so no extra audio software is needed.
- A small sound meter in the banner shows that it's actually hearing the call. This matters because macOS can fail to capture audio without showing any error.
- The audio streams to a cloud transcription service that detects when the interviewer has finished speaking. The service is primed with your Sheet's terms (TTA, LL.M., qui tam, 338(h)(10), case names and so on).
- **Nothing is recorded or saved.**

### 3.3 Matching at two speeds

1. **Instant, on your Mac, as every word arrives.**
   - The words so far are compared against every piece's "when to use" signals. They're also compared against alternative wordings of each question that the tool writes at load time; those wordings are used only for matching and are never shown.
   - A dimmed first guess appears, often before the interviewer finishes.
   - If the internet drops, this still works on its own.
2. **Confirmed, by Claude, when the interviewer stops talking.**
   - Claude receives the question, the recent conversation, what has already been shown, and your whole Sheet. Your Sheet is loaded once when you press Start, so it isn't re-sent for each question.
   - Claude returns **only piece numbers**, plus a lead-in when one is needed.
   - The request starts on the transcription service's early "they're finishing" signal, so the answer is often ready when they stop.
   - The banner then locks. **Once you start scrolling, it never switches the text.**

Matching rules:

- "Tell me about a time…" gets the Question Finder opening line plus the story. "What's your… / How do you…" gets the Classic or Core Narrative answer. This comes from the Sheet's "How to use this sheet" section.
- Follow-ups are matched in context. "What would you do differently?" goes to the version under the story that was just shown.
- When the interviewer points to your resume, the tool shows the short Resume Walkthrough answer. If they ask for more, it shows the linked story.
- Technical talking points are used only when the interviewer goes technical.
- Small talk, and the interviewer talking about themselves, shows nothing (no flag). It can still feed suggested questions.

### 3.4 The banner

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Story 3 · <story title>              → <cue from the Sheet>          ●●○ ▮▮▯│  label line: source, Sheet cue, confidence, audio meter
│ Situation: <the story's text, exactly as written in the Sheet, wrapping     │
│ normally across about three lines of large type, scrolled by hand with the  │  ~3 lines, trackpad scroll
│ trackpad…>                                                                  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│  progress through the script
└──────────────────────────────────────────────────────────────────────────────┘
   [ runner-up: Story N ]                       ┌ Questions to ask ─────────────┐
                                                │ • (Sheet) …                   │
                                                │ • (Suggested) …               │
                                                │ • (Sheet, closer) Next steps? │
                                                └───────────────────────────────┘
```

- A wide strip that stays on top of other windows. You can drag it and resize it. It's meant to sit at the top of the screen near the camera.
- About 3 lines of large text (font size adjustable), ordinary wrapping, trackpad scrolling, and a thin progress bar.
- The label line shows which piece is on screen, any cue from the Sheet, the confidence of the match, and the audio meter.
- A lead-in appears in a different color, directly before the script.
- **Not in Sheet:** a clear flag, then the closest related material, labeled "closest".
- The second-best match is one click away.
- Faint underline: on a back-reference whose story hasn't been shown yet in this interview.
- **Questions to ask:** a small separate area. Your Sheet's questions come first. Occasional suggestions based on what the interviewer said are labeled as suggestions. "What are the next steps in the process?" stays pinned as the closing question.

## 4. Keeping your words exact

These are design guarantees, not promises:

1. **The AI never writes script text.** It returns piece numbers, and the banner copies the text from the loaded Sheet.
2. **Every display is checked.** Before anything is shown, everything outside a lead-in is compared against the Sheet. If it doesn't match, it isn't shown.
3. **Lead-ins are limited.** They have their own color, a cap of about 15 words, and are thrown out automatically if they add any name, number or claim.
4. **Suggestions stay in their own area,** labeled as suggestions.

The realistic failure is **showing the wrong script**: your real words, answering the wrong question. Five things reduce that risk:

- the Sheet's own matching rules;
- matching in context;
- the confidence indicator;
- the runner-up one click away;
- the test set in section 6.

## 5. How it's built

- **The app.** A Mac app built with Electron (a web-based desktop app framework), written in TypeScript.
  - Current Electron captures system audio through Apple's Core Audio tap.
  - It needs the macOS "System Audio Recording" permission.
  - The banner is a frameless, always-on-top window.
- **The core.** Sheet loading, exact-text checks, matching rules and the Claude call are plain TypeScript. That means they can be built and tested off the Mac.
- **Transcription.** A cloud streaming service with built-in end-of-turn detection.
  - Candidates: Deepgram Flux and AssemblyAI Universal-Streaming.
  - The winner is chosen by measuring both on a recording of a real Teams call.
- **Claude.** Your Sheet is held in Claude's prompt cache and kept warm during the interview. Responses use structured output limited to piece numbers and an optional lead-in.
  - Model: **to be decided by measurement.** The options are Claude Opus 5.5 at low effort (likely most accurate) and Claude Haiku 5.5 (likely fastest). Both run against the test set and you choose.
- **Keys.** You'll need an API key for the transcription service and an Anthropic API key. They're stored in the macOS Keychain.
- **Privacy.**
  - The interviewer's audio goes to the transcription service.
  - The Sheet and the transcript go to the Anthropic API.
  - Nothing is saved on disk by default.
  - The Sheet is never committed to this repository, which appears to be public.

## 6. Testing

1. **Exact-text tests.** Every piece and every displayed combination is checked against the Word file automatically.
2. **Matching test set.** About 150 realistic ways an interviewer might ask things, which you can review and add to. It includes:
   - different wordings of every Sheet question;
   - follow-ups asked in context;
   - resume pointers;
   - technical questions;
   - questions the Sheet doesn't cover, which should get the flag plus closest material;
   - small talk, which should show nothing.

   Reported: accuracy by category and time to answer, for each model and transcription option.
3. **On your Mac.** Listening, the banner, and a full end-to-end run on a real Teams call, with someone reading questions to you.

## 7. Build order

1. **Sheet loader and exact-text checks.** Splitting the Word file, recognizing notes, pairings, back-references, and the data behind the review screen.
2. **Matching.** The instant on-device matcher, the Claude matcher, the test set, the accuracy and speed report, and the model choice.
3. **Banner and review screen.** The Electron window, the 3-line text area, the label line, lead-in styling, the "Not in Sheet" flag, the runner-up, the questions area and the underline.
4. **Listening.** System-audio capture, streaming transcription with end-of-turn detection, the audio meter, and choosing the transcription service.
5. **Final tuning.** Speed, keeping the cache warm, and handling network loss (falling back to instant matching only), followed by the full Teams test on your Mac.

Steps 1–2 and most of step 3 can be built and tested in the cloud. Steps 4–5 need your Mac.

## 8. Open items

- Choose the Claude model (after the measurements in step 2).
- Choose the transcription service (after the measurements in step 4).
- Set up the API keys (before step 2).
- Decide where the Sheet lives for testing. This repository appears to be public, so the Sheet stays out of it. Either upload it each session, or make the repository private and keep a test copy here.

## 9. Build status

| Step | Status |
|---|---|
| 1. Sheet loader and exact-text checks | Done. Tested on a fictional Sheet and on your real Sheet: 428 paragraphs, 148 pieces, all 31 Question Finder pairings, both back-references found. |
| 2. Matching | Done. The on-device matcher gets 95% right or acceptable on a 141-question test set, with 2.1% wrong. The Claude router is built, with ids-only structured output and a cached Sheet. Claude's accuracy and speed need an API key to measure. |
| 3. Banner and review screen | Done. Ran the real app end to end under a virtual display: load, review, approve, test questions, follow-up in context, Not in Sheet, questions tray. |
| 4. Listening | Written: system-audio capture through the Core Audio tap and Deepgram Flux streaming. The Deepgram client is tested against a local stand-in server. Real capture needs a Mac. |
| 5. Final tuning | After your first Teams dry run. |

