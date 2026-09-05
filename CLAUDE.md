# CLAUDE.md

Telegram bot on Cloudflare Workers: takes a video (upload or social link), transcribes the
speech, translates it, and burns the translated captions back into the video.

## Commands

```bash
npm run typecheck      # tsc --noEmit — the only verification that runs on this machine
npm run dev            # wrangler dev
npm run deploy         # wrangler deploy (needs Docker for the container image)
npm run types          # regenerate worker-configuration.d.ts from wrangler.jsonc
npm run set-webhook    # point Telegram at the deployed worker; also publishes the ☰ menu
npm run usage          # container usage + projected cost
npm run r2-lifecycle   # one-time: expire jobs/ objects after 2 days
```

Endpoints (all secret-gated with `TELEGRAM_WEBHOOK_SECRET`):
`/health` · `/debug/fonts?secret=…` (what libass can actually see) · `/telegram/commands?secret=…`
(republish the ☰ menu after changing `COMMANDS`) · `POST /telegram/webhook`.

## Architecture

Three layers, each with a different billing model:

1. **Worker** (`src/index.ts`) — webhook handler. Answers Telegram in milliseconds and does the
   real work in `ctx.waitUntil`, because anything but a fast 200 makes Telegram retry and queue
   duplicates.
2. **Workflow** (`src/pipeline/workflow.ts`) — the durable pipeline. Each stage is a `step.do`,
   so a failure retries that slice instead of the whole job.
3. **Container** (`src/media/container.ts`, `container/server.js`) — ffmpeg, one instance per job
   via `getByName(jobId)`, so files persist on its disk between calls.

Pipeline: fetch → extract audio → transcribe (chunked) → translate → burn → deliver → offer edit.

A finished run leaves the input video and `segments.json` (transcript **and** translation) in R2
for 24h, which is what lets the ✏️ Edit card re-run at four depths — `full`, `retranscribe`,
`retranslate`, `restyle`. `pickMode` in `src/bot/edit.ts` picks the shallowest one that can serve
the change, so a font change costs one encode and a translator change costs no transcription.

## Key files

| File | Role |
|------|------|
| `src/pipeline/ai.ts` | STT provider chain, sentence grouping, translation |
| `src/pipeline/workflow.ts` | Stage orchestration and what gets stored in R2 |
| `src/captions/settings.ts` | Every user-facing setting; menus and validation derive from `MENUS` |
| `src/captions/subtitles.ts` | ASS generation, presets, RTL shaping |
| `src/bot/edit.ts` | Per-video re-run card |
| `src/bot/menu.ts` | `/settings` keyboards, shared with the edit card via `MenuScope` |

## Gotchas

- **Container time is the cost driver.** It bills for provisioned memory the whole time it is
  awake, so idle minutes cost the same as working ones. The workflow deliberately stops it before
  translating and restarts it to burn. Never leave it running across a phase that does not use it.
- **`SUBTITLE_FONT` must be the font's internal family name**, not its filename. On a mismatch
  libass fails *silently* to a Latin font, which renders Arabic as tofu. Check with `/debug/fonts`.
- **`CODE_FIELDS` in `settings.ts` is append-only.** It encodes settings into `callback_data` one
  base-36 digit per field; reorder it and buttons minted by the previous deploy decode to the
  wrong settings.
- **The edit card keeps its draft on the buttons, not in KV.** KV is eventually consistent, so a
  read-modify-write per tap can serve a stale draft and silently undo the user's changes.
- **Stored cues are deliberately unfitted** to any line length. Line length is a per-job setting,
  so `refitSegments` applies it at burn time — that is what lets a restyle re-fit the same text.
- **Translate whole sentences, never caption-sized fragments.** Transcription stays at the
  provider's granularity and `groupForTranslation` merges it into sentences; splitting first is
  what produced wrong translations, because each half was translated with no context.
- **Adding a settings field surfaces it in both menus** — `/settings` and the per-video edit card
  share `MENUS`. If a new field cannot actually change a delivered video, `pickMode` must know
  which re-run depth it needs.
- **`abandon(..., purge)` must be false for re-runs.** Purging on a failed re-transcribe would
  delete the assets behind a video the user already has.
- **Hand-corrected text lives in `segments.json`, so a re-translate discards it.** ✍️ Fix text
  (`src/bot/edit.ts`) writes corrections straight into the stored cues and re-burns with a plain
  `restyle` — there is no fifth mode, because `restyle` already burns whatever that object holds.
  `retranslate` and `retranscribe` rewrite it from the transcript, which is why the confirmation
  says so before offering that button.
- **A correction is addressed by its timestamp, not its index.** The cue list is posted as `<pre>`
  blocks so Telegram gives each one a copy button, and a pasted-back block is matched on start
  time within 0.6 s. `BLOCK` in `edit.ts` is also the predicate deciding whether a plain message
  is a correction at all, so loosening it makes ordinary chat start hitting KV.

## Environment

Vars live in `wrangler.jsonc`; secrets go in `.dev.vars` locally (`npx wrangler secret put` in
production). See `.dev.vars.example`. `ADMIN_CHAT_ID` fails **open** when unset — the bot is
public until you set it.

Language, transcriber and translation model are per-chat settings; the vars only seed the
defaults, and a value not on the menu falls back rather than being used verbatim.

## Verification

Docker is not installed on this machine, so the container cannot be built, deployed or dry-run
here. Anything touching ffmpeg, burning or fonts is **unverified by definition** — say so rather
than implying it was tested. `npm run typecheck` is the real check.
