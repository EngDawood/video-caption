---
name: video-caption-mcp
description: This skill should be used when the user asks to "caption this video", "burn subtitles into this TikTok", "translate this reel", "add Arabic captions to this video", "subtitle this YouTube short", asks how to connect to or use the video-caption MCP server, or mentions its tools by name (submit_job, job_status, get_output). Covers connecting to the /mcp endpoint, submitting a caption job, polling it, and returning the finished download link.
version: 0.1.0
---

# Using the video-caption MCP

The video-caption MCP server exposes one pipeline over three tools: fetch a video from a social
post, transcribe the speech, translate it, burn the translated captions into the picture, and
leave an MP4 behind a signed link. It runs on Cloudflare Workers and takes **minutes**, not
seconds.

Every `submit_job` call starts a new paid run. Treat it as spending money.

## Connecting

This plugin ships the server in its `.mcp.json`, so connecting is a matter of two environment
variables in the shell that launches Claude Code:

```bash
export VIDEO_CAPTION_API_KEY=<the Worker's API_KEY secret>
```

The URL defaults to `https://vc.engdawood.com/mcp`, the Worker's custom domain. The
`*.workers.dev` URL keeps working alongside it, so `VIDEO_CAPTION_MCP_URL` can point at
`https://video-caption.engdawood.workers.dev/mcp` to bypass the custom domain.

They are expanded once at launch, so a key set after Claude Code started will not be picked up —
restart the session.

Outside this plugin, add it by hand:

```bash
claude mcp add --transport http video-caption https://<host>/mcp --header "x-api-key: <API_KEY>"
```

Auth fails **closed**: if `API_KEY` is unset on the Worker, every call gets `403 forbidden` rather
than running unauthenticated. `?token=<API_KEY>` on the URL is accepted as a fallback for clients
that cannot send custom headers (ChatGPT); prefer the header, since a query token ends up in logs,
proxies and shell history.

Note that the download links `get_output` mints are built from the Worker's own `API_BASE_URL` var,
*not* from the URL used to reach `/mcp`. If a returned link points at a different host than the one
just called, that var is stale on the deployment — the job itself is fine.

## The three tools

| Tool | Call it when | Returns |
|------|--------------|---------|
| `submit_job` | The user wants a video captioned | `{ jobId }` |
| `job_status` | Checking whether that job finished | `{ jobId, status, error? }` |
| `get_output` | Status is `complete` | `{ jobId, ready, url }` |

Run them in that order. Never re-call `submit_job` to check on a job — that starts a second run and
returns a different `jobId`.

## submit_job

```json
{
  "sourceUrl": "https://www.tiktok.com/@user/video/123",
  "callbackUrl": "https://example.com/hooks/caption",
  "settings": { "targetLang": "ar", "font": "almarai" }
}
```

**`sourceUrl`** — a public *post* URL on TikTok, Instagram, YouTube, X, Facebook or Threads. A
direct `.mp4`/CDN file link is not accepted: the URL goes through the same resolver a Telegram link
does. If the user pastes a file link, ask for the post it came from.

**`callbackUrl`** — required, and must be `https://`. There is no way to submit a job without one.
Every progress and completion event is POSTed there as JSON. A failed POST is logged and swallowed,
so a callback endpoint that does not exist does not break the run:

> With no receiver to point at, pass an https endpoint the user controls (or a request-bin style
> URL) and **poll `job_status` instead**. Do not invent a plausible-looking URL for someone else's
> domain.

Callback bodies all carry `jobId`:

| Event | Body | Meaning |
|-------|------|---------|
| `progress` | `{ event, message }` | Stage narration |
| `completed` | `{ event, downloadUrl }` | Done. That URL is the *unsigned* `/api/jobs/{id}/output` and needs `x-api-key` — use `get_output` for a link a person can open |
| `failed` | `{ event, error }` | The run failed |
| `stopped` | `{ event, message }` | Ended with no video (e.g. no speech found) |

**`settings`** — name only the fields that should differ from the deployed defaults; everything else
is filled in server-side. See `references/settings.md` for every field and value.

## Polling

After submitting, wait and call `job_status`. A typical job is a few minutes — poll roughly every
30 seconds, not in a tight loop.

`status` is one of `queued`, `running`, `paused`, `waiting`, `waitingForPause`, `complete`,
`errored`, `terminated`, `unknown`. Only `complete` means a video exists. `errored` carries `error`
with the reason.

## Getting the video

`get_output` returns `{ jobId, ready, url }`.

- `ready: false` means the MP4 is not in R2 yet. **The `url` is returned anyway** and will 404 —
  only use it once `ready` is true and status is `complete`.
- The URL is HMAC-signed and valid for **24 hours**. It opens directly in a browser with no
  credential, so hand it to the user as a link.
- Never try to download and inline the MP4. It is tens of megabytes; the tool returns a link for
  exactly that reason.
- R2 expires the object after two days regardless of the signature.

## What gets a submission rejected

- **`review: "on"` or `preview: "on"`** — rejected outright. Both pause the run on a Telegram card
  that does not exist over MCP. Omit them, or set `"off"`.
- **`confirm`** — accepted but inert. It gates the Telegram start card only; over MCP the job starts
  immediately either way.
- **An off-menu value** — `settings.<field>: "x" is not one of the options this bot offers`.
- **Capacity** — `429`, "the API is at capacity right now — try again shortly". Wait and resubmit;
  no job was created.

## The one setting trap worth knowing up front

Font coverage is a language decision, not a style one. `aljazeera` and `thmanyah` are **Arabic-only**
and are missing letters Urdu needs (ٹ ڈ ڑ ں ے); `thmanyah` also misses Persian's گ ک ی ژ ہ. For
`targetLang: "ur"` or `"fa"`, pick `noto`, `almarai` or `cairo`. A missing glyph renders as a box or
a blank gap in the burned video — there is no error.

## Additional resources

- **`references/settings.md`** — every settings field, its values, and the deployed defaults.
- **`references/troubleshooting.md`** — error strings and status values mapped to causes and fixes.
