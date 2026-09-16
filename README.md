# video-caption

A Telegram bot on Cloudflare Workers that takes a video (upload or social link), transcribes
the speech, translates it, and burns the translated captions back into the video.

## How it works

1. **Worker** (`src/index.ts`) — handles the Telegram webhook, replies fast, and kicks off the
   real work in the background.
2. **Workflow** (`src/pipeline/workflow.ts`) — the durable pipeline: fetch → extract audio →
   transcribe (chunked) → translate → burn → deliver → offer edit. Each stage can retry on its
   own without redoing the whole job.
3. **Container** (`src/media/container.ts`, `container/server.js`) — runs ffmpeg, one instance
   per job, so files persist on disk between calls.

Per-video settings (language, transcriber, translation model, caption style, etc.) can be
confirmed before a job starts, and a finished job can be re-run at four different depths
(full, retranscribe, retranslate, or restyle only) from an edit card in the chat.

See [`CLAUDE.md`](./CLAUDE.md) for full architecture notes, key files, and known gotchas.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in secrets, see below
npm run types                    # generate worker-configuration.d.ts
```

### Secrets (`.dev.vars` locally, `wrangler secret put` in production)

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Shared secret validating the Telegram webhook |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Only for `npm run usage` |
| `GROQ_API_KEY` / `MISTRAL_API_KEY` | Only if `STT_PROVIDER` in `wrangler.jsonc` is set away from `workers-ai` |
| `DOWNLOAD_API_KEY` | Lets the bot fetch a video from a social link instead of an upload; unset means links are refused, uploads still work |
| `API_KEY` | Required for the external `/api/jobs` REST API (`x-api-key` header); unset closes that surface entirely |

Other settings (language/transcriber/model defaults, `ADMIN_CHAT_ID`, `SUBTITLE_FONT`, etc.)
live in `wrangler.jsonc`. Note `ADMIN_CHAT_ID` fails **open** — the bot is public until it's set.

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

### Endpoints

All secret-gated with `TELEGRAM_WEBHOOK_SECRET` unless noted:

- `GET /health`
- `GET /debug/fonts?secret=…` — what libass can actually see
- `GET /telegram/commands?secret=…` — republish the ☰ menu after changing `COMMANDS`
- `POST /telegram/webhook`
- `/api/jobs` — external REST API, gated by the `API_KEY` secret (`x-api-key` header)

## Verification

Docker isn't required for `npm run typecheck`, but building/deploying the container
(`npm run deploy`) does need it. Anything touching ffmpeg, burning, or fonts can't be
exercised without a deploy — see `CLAUDE.md` for details.
