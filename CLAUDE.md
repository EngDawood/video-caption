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

With 🧾 **Confirm settings** on — the default — nothing starts until the user approves. Every
video, uploaded or linked, opens on a card listing what it is about to be captioned with; the
draft rides on the buttons as an `encodeSettings` code and is handed to the Workflow in
`params.settings`, so a change there applies to that video and is never written back to KV. A
link's preview and its approval are the *same* card — `sendOffer` posts the settings card with
the platform/quality line above it rather than making the user confirm twice. Turning the field
off restores the old behaviour: an upload starts on arrival, a link gets the plain ✅ Caption it
offer.

With 📝 **Check script** on, the run *ends* after translate and posts the script as an `.srt` with
a ✅ Burn it card. The burn is then the same `restyle` re-run the ♻️ Apply button has always
queued, over the cues already in R2 — no Workflow instance is held open waiting for a tap, and
the container had already been released before the translation anyway.

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
| `src/captions/text.ts` | Strips what no caption font can draw — see the tofu gotcha below |

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
  `TRANSLATION_UNIT_CHARS` is the trap: a cap reached mid-sentence used to close the unit wherever
  it stood, re-creating the very split the grouping exists to prevent. A forced break now rewinds
  to the last sentence end in the buffer and carries the rest forward. Whisper returns stretches
  with *no* punctuation at all, where there is nothing to rewind to — so every unit is also
  translated with its neighbours as `CONTEXT BEFORE` / `CONTEXT AFTER`, which the model is told to
  read but never translate. Only chat translators get that; `m2m100` has no prompt to put it in.
- **A translation is checked for being in the target script before it is kept.** `isPlausible`
  rejects CJK outright and requires a fifth of the letters to be in the target's script — fp8
  Llama leaks stray tokens from other languages (a Chinese 几乎 landed mid-Arabic), and
  `translateText` used to retry only on a throw or an empty string, so anything else was burned
  in. A rejected answer is still kept over untranslated source text if the retry fails too.
- **Boxes inside Arabic words are a character the font cannot draw, not a bidi bug.** libass hands
  the string to HarfBuzz as it stands, so anything with no glyph is drawn as `.notdef` — a box on
  Al Jazeera (its `.notdef` is a rectangle), a blank gap on Thmanyah (CFF, empty `.notdef`). Four
  sources, all handled by `sanitize` in `src/captions/text.ts`:
  **U+FFFD**, which is what a UTF-8 decoder leaves where bytes were malformed. It looks like
  nothing in a paste, so it survives every eyeball check.
  **A lone surrogate**, which is the same box arriving by a route stripping U+FFFD cannot close.
  It is not a formatting character and not a presentation form, so every sanitising pass waves it
  through; then `putSubtitles` hands the finished ASS to the container as a `fetch` body, and
  encoding a string to UTF-8 rewrites each unpaired surrogate as U+FFFD. The replacement character
  is therefore *born after* the last stage that touches text, in a step that has no text handling
  in it at all. `\p{Cs}` at the source is the only place to stop it — which is why the class is now
  the whole of `\p{C}` rather than `Cf` alone, with U+200C and the whitespace controls exempted so
  ZWNJ spelling and `refitSegments`' line breaks survive.
  **Arabic presentation forms** (U+FB50–U+FDFF, U+FE70–U+FEFF), the deprecated legacy block. Only
  a font shipping it can draw them and no font ships it whole — Al Jazeera has 125/144 of Pres-B,
  Thmanyah 89/144 and none of the isolated forms. NFKC on just those characters restores the
  canonical letters, which every Arabic font shapes through its own GSUB.
  **Invisible formatting characters** — all of `Cf`, since `buildAss` already wraps each RTL line
  in its own RLE/PDF pair and anything else is pure risk, and with them `Co` and `Cn`, which no
  font carries by definition. U+200C is the exception: Persian and Urdu spell words with it.
  Applied where text is produced *and* inside `escapeAss` as the backstop for cues stored in R2
  before it existed. `buildAss` then logs two censuses: `foreignCharacters` names what was
  stripped, and `unexpectedCharacters` names what survived and is still not ordinary caption text
  — that second one is the half that matters, because a character nobody anticipated would
  otherwise leave the log empty and the video full of boxes.
- **Font coverage is a per-language decision, not a style one.** Al Jazeera and Thmanyah are
  Arabic-only: both miss ٹ ڈ ڑ ں ے, so Urdu breaks on either, and Thmanyah also misses گ ک ی ژ ہ
  and the Persian digits. Noto Naskh Arabic carries the whole Arabic block plus both supplements.
  `FONTS` in `settings.ts` is append-only for the same reason as `CODE_FIELDS` — `MENUS.font`
  indexes it onto the buttons.
- **A settings field that cannot change an existing video belongs in `CHAT_ONLY`.** `MENUS` drives
  both menus, and `MenuScope.fields` is what narrows the per-video card to `EDIT_FIELDS` —
  reviewing a script is meaningless on a card posted after the burn.
- **Adding a settings field surfaces it in both menus** — `/settings` and the per-video edit card
  share `MENUS`. If a new field cannot actually change a delivered video, `pickMode` must know
  which re-run depth it needs.
- **`abandon(..., purge)` must be false for re-runs.** Purging on a failed re-transcribe would
  delete the assets behind a video the user already has.
- **Hand-corrected text lives in `segments.json`, so a re-translate discards it.** ✍️ Fix text
  (`src/bot/edit.ts`) writes corrections straight into the stored cues and re-burns with a plain
  `restyle` — there is no fifth mode, because `restyle` already burns whatever that object holds.
  `retranslate` and `retranscribe` rewrite it from the transcript, which is why the confirmation
  says so before offering that button. Deleting a cue drops its transcript run too, so a
  re-translate cannot resurrect a line the user removed.
- **Translated text is whitespace-normalised where it is produced, not at the burn.** `clean` only
  ever ran on STT output, so a translator that doubled a space had it burned in — a cue short
  enough to skip `resegment` never has its words rejoined. `translateSegments` normalises now, and
  `refitSegments` repeats it as the backstop for cues already stored in R2.
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
