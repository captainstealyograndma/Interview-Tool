# Interview Banner 2

A teleprompter for live interviews. It listens to the interviewer on a Teams or Zoom call, finds the matching part of your prep Sheet, and shows those exact words in a banner at the top of your screen near the camera. When the Sheet has no answer, it drafts one from your materials, streamed word by word and clearly marked as drafted.

This is a separate app from the original **Interview Banner**. Both can be installed at the same time; this one never touches the other's settings. See [PLAN.md](PLAN.md) for the design.

---

## One-time setup on your Mac

You need macOS 14.2 or newer.

1. Install **Node.js** from <https://nodejs.org> if you haven't already (the LTS download). If you installed the original Interview Banner, you have it.
2. Open **Terminal** (⌘ + Space, type `Terminal`, Return), paste this line, and press Return:
   ```
   curl -fsSL https://raw.githubusercontent.com/captainstealyograndma/Interview-Tool/refs/heads/claude/interview-prep-tool-brainstorm-9npr4a/install-mac.sh | bash
   ```
   It downloads the code, builds the app, puts **Interview Banner 2** in your Applications folder, and opens it. About 5–10 minutes.

To update later, run the same line again.

## First run

1. **Keys.** Paste your **Anthropic API key** and **Deepgram API key** and click **Save** for each. macOS keeps each app's encrypted keys separate, so the keys from the original app can't be carried over; create new ones at console.anthropic.com → API Keys and console.deepgram.com → API Keys if you no longer have them.
2. **Model.** Claude Haiku 5.5 is the default and recommended: it answers in well under a second. Claude Opus 5.5 is available but slower.
3. **Interview.** The app keeps one profile per interview. If the original app had a Sheet, a profile for it was created for you, with its approval carried over.
   - **New interview…** creates a profile. Give it a name (firm and role).
   - **Choose Sheet…** picks the Word file (required).
   - **Your materials (optional):** Resume, Cover letter, Job posting, as Word, PDF or plain text. They are used only to ground drafted answers and to help the transcriber with names. Nothing in them is ever shown as script.
   - **Save a blank Sheet template…** gives you a Word file in the structure the app reads, for future interviews.
4. **Review & approve.** Check the Question Finder pairings, then **Approve this Sheet**. On approval the app also asks Claude for about 12 alternative wordings of every item (about a minute, in the background). Those only help it recognize questions faster; they are never shown.
5. **Test without a call.** Type things an interviewer might say and click **Ask**.
6. **Start listening.** The first time, macOS asks to allow **Screen & System Audio Recording** for Interview Banner 2. Click **Allow**. If you missed it: System Settings → Privacy & Security → Screen & System Audio Recording → turn on **Interview Banner 2**, then quit and reopen the app.

**Do a dry run** on a Teams call with a friend before the real interview.

## During the interview

| What you see | What it means |
|---|---|
| Dimmed text, "listening · likely" | An early guess while the interviewer is still talking |
| Bright white text | Your Sheet, word for word. Read it. |
| *Amber italic* words at the start | A short lead-in so the first sentence answers the question as asked. At most 15 words, only words from the question and your script. |
| **DRAFTED** label, amber text | Your Sheet has no answer. This was drafted from your Sheet, resume, cover letter and job posting, plus what has already come up. It streams in; start reading when the first sentence is there. |
| Dotted **red** underline (in a draft) | A name, number or claim not found in your materials. Skip it or say it, your call. |
| Dotted **amber** underline (in Sheet text) | A phrase that refers to a story you haven't told yet |
| ↺ button | Shows the second-best match instead. On a draft, it shows the Sheet's closest material. |
| Red **NOT IN SHEET** | Only appears if drafting fails (for example, no connection). The closest Sheet material is shown. |
| A− / A+ | Text size |
| × | Hides the banner until the next question |

Two-finger scrolling moves through the text. Once you scroll, the text never switches until the next question.

The **Questions to ask** window lists your Sheet's questions, with your closing question kept last. Suggestions based on what the interviewer said appear in blue. Click a question to cross it off. This part is unchanged from the original app.

If Claude is slow, the banner shows the on-device match meanwhile and updates when Claude answers. Claude's answer is never thrown away.

## Changing your Sheet

Edit the Word file, then click **Reload**. A changed Sheet needs to be reviewed and approved again. Keep each question line as a Heading 3 and every answer paragraph in the Normal style; a paragraph accidentally styled as a heading becomes its own item and leaves the question above it empty.

## Measuring accuracy (optional)

```
npm run benchmark -- path/to/Sheet.docx path/to/testset.json
ANTHROPIC_API_KEY=... npm run benchmark -- path/to/Sheet.docx path/to/testset.json --claude claude-haiku-5-5
```

## For development

```
npm test            # tests (a fictional Sheet; your real Sheet too if it's at private/sheet.docx)
npm run typecheck
npm run inspect-sheet -- path/to/Sheet.docx
npm run make-template
npm start           # run without packaging (system audio needs the packaged app)
```

Code layout:
- `src/core/`: Sheet reader and exact-text checks, matcher, Claude router, drafter and claim check, materials reader, session engine, Deepgram client. No Electron code.
- `src/main/`: the Electron main process (windows, profiles, settings, IPC).
- `src/renderer/`: the windows (setup, review, banner, questions tray) and the audio worklet.
- `templates/`: the blank Sheet template.
- `private/`: your real Sheet and test sets. Ignored by git.

The original Interview Banner is commit `744f4f6` in this branch's history. Its installed copy keeps working on its own; to rebuild it from source, check out that commit.
