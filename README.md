# Interview Banner

A teleprompter for live interviews. It listens to the interviewer on a Teams or Zoom call, finds the matching part of your prep Sheet, and shows those exact words in a banner at the top of your screen near the camera.

The Sheet is the only source of answers. The AI only chooses which numbered piece of your Sheet to show. It never writes or rewords your answers. See [PLAN.md](PLAN.md) for the full design.

---

## One-time setup on your Mac

You need macOS 14.2 or newer (Tahoe is fine).

1. Install **Node.js** from <https://nodejs.org>. Click the LTS download, open the `.pkg` file, and click through the installer.
2. Open **Terminal** (press ⌘ + Space, type `Terminal`, press Return), paste this line, and press Return:
   ```
   curl -fsSL https://raw.githubusercontent.com/captainstealyograndma/Interview-Tool/refs/heads/claude/interview-prep-tool-brainstorm-9npr4a/install-mac.sh | bash
   ```
   It downloads the code, builds the app, puts **Interview Banner** in your Applications folder, and opens it. It takes about 5–10 minutes.

To update later, run the same line again.

## First run

1. **Keys.** Paste your **Anthropic API key** and your **Deepgram API key**, and click **Save** for each.
   - They're encrypted with your Mac's Keychain.
2. **Model.** Choose Claude Opus 5.5 (most accurate) or Claude Haiku 5.5 (fastest).
3. **Your Sheet.** Click **Open Sheet…** and choose your Word file.
   - The app checks every paragraph word for word. You'll see **word-for-word check passed**.
4. **Review & approve.** In the review window:
   - **Question Finder pairings:** each entry shows its opening line plus the part of the story your Sheet names. If you want different paragraphs, change the checkboxes.
   - **Back-references:** phrases like "the project I told you about" get a faint underline until that story has come up.
   - **Everything, by section:** <mark>highlighted</mark> text is a note to you and is never shown as words to say.

   Click **Approve this Sheet** when it looks right.
5. **Optional: Improve instant matching.** This asks Claude for alternative ways each question might be phrased. They're only used to recognize questions faster, never shown. It takes about a minute.
6. **Test without a call.** Type things an interviewer might say ("Tell me about a time you failed.") and click **Ask**. The banner shows what it would display in a real call.
7. **Start listening.** The first time, macOS asks to allow **Screen & System Audio Recording**. Click **Allow**.
   - If you missed the prompt, open **System Settings → Privacy & Security → Screen & System Audio Recording**, turn on **Interview Banner**, then quit and reopen the app.
   - The app only captures the call's audio coming out of your Mac, never your microphone. Nothing is recorded or saved.

**Do a full dry run** before the real interview. Start a Teams call with a friend, or play an interview video, and watch the banner follow along.

## During the interview

Open Teams or Zoom, then click **Start listening**. Drag the banner to the top of your screen, just under the camera.

What you'll see in the banner:

| What you see | What it means |
|---|---|
| Dimmed text, "listening · likely" | An early guess while the interviewer is still talking |
| Bright text | Confirmed. Read it. |
| Two-finger trackpad scroll | Moves through the text. Once you scroll, the text never switches until the next question. |
| **Bold** labels (Situation:, Task:…) | Shown exactly as in your Sheet |
| *Amber italic* words at the start | A short AI-written lead-in. These are rare and can only use words from the question or your script. |
| Dotted underline | This phrase refers to a story you haven't told yet. Your call in the moment. |
| Red **NOT IN SHEET** | Your Sheet doesn't cover this question. The closest material is shown, labeled "Closest". |
| ↺ button | Shows the second-best match instead |
| A− / A+ | Text size |
| × | Hides the banner. It comes back on the next question. |

The **Questions to ask** window lists your Sheet's questions, with your closing question kept last. Suggestions based on what the interviewer said appear in blue, marked "Suggested". Click a question to cross it off.

If Claude is slow or unreachable, the banner falls back to the on-device match and says so ("instant match (Claude unavailable)").

## Changing your Sheet

Edit the Word file, then click **Reload**. A changed Sheet needs to be reviewed and approved again.

## Measuring accuracy (optional)

You can run a test set of interviewer questions through the matcher. The test set is a JSON list of `{"q": "...", "expect": ["Q1"]}`.

```
npm run benchmark -- path/to/Sheet.docx path/to/testset.json
ANTHROPIC_API_KEY=... npm run benchmark -- path/to/Sheet.docx path/to/testset.json --claude claude-haiku-5-5
```

## For development

```
npm test            # tests (a fictional Sheet; your real Sheet too if it's at private/sheet.docx)
npm run typecheck
npm run inspect-sheet -- path/to/Sheet.docx   # how a Sheet was split into pieces
npm start           # run without packaging (system audio needs the packaged app)
```

Code layout:
- `src/core/`: Sheet reader and exact-text checks, matcher, Claude router, session engine, Deepgram client. No Electron code here.
- `src/main/`: the Electron main process (windows, settings, IPC).
- `src/renderer/`: the windows (setup, review, banner, questions tray) and the audio worklet.
- `private/`: your real Sheet and test sets. This folder is ignored by git.
