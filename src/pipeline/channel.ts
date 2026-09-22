import { sendEditCard, sendReviewCard, type ReviewCard } from '../bot/edit';
import { cancelKeyboard } from '../bot/jobs';
import { telegram } from '../bot/telegram';
import { releaseSlot } from '../api/concurrency';
import { recordProgress } from '../api/progress';
import { callbackSignature, outputUrl } from '../api/output';
import type { CaptionSettings } from '../captions/settings';
import type { CaptionJob, Env } from '../types';

/**
 * Where a job's progress, finished video and follow-up cards go.
 *
 * `workflow.ts` is otherwise channel-agnostic: every place it used to call
 * `tg.*` directly now goes through whichever `Channel` `channelFor` builds for
 * the job, so a non-Telegram caller (the webhook API) only has to implement
 * this interface, not touch the pipeline.
 */
export interface Channel {
  /** A progress line. Telegram edits the status message; other channels may no-op. */
  progress(text: string): Promise<void>;
  /** The last line for a run that ends with nothing to deliver — empty, cancelled, waiting on review. */
  settle(text: string): Promise<void>;
  /** The run threw. Distinct from `settle` so a structured channel can report it as an error, not just a status line. */
  fail(reason: string): Promise<void>;
  /**
   * The finished video, once `burn-subtitles` has written it to `keys.output`.
   * `load` reads it from R2 — called only by a channel that sends the bytes.
   */
  deliver(load: () => Promise<ArrayBuffer>): Promise<void>;
  /** Offer to check the script before burning. False if it could not be posted. */
  offerReview(assetJobId: string, settings: CaptionSettings): Promise<ReviewCard | false>;
  /** Offer to restyle the delivered video. A no-op where there is no such follow-up. */
  offerEdit(assetJobId: string, settings: CaptionSettings): Promise<void>;
}

/**
 * The Telegram channel: today's only one, moved here unchanged from
 * `workflow.ts` so future channels can sit next to it without touching the
 * pipeline steps.
 */
function telegramChannel(env: Env, job: CaptionJob): Channel {
  const { chatId, messageId, statusMessageId, cancelToken } = job;
  // Only ever missing on an API job, which never reaches here — channelFor
  // routes those to webhookChannel instead.
  if (chatId === undefined || messageId === undefined) {
    throw new Error(`job ${job.jobId} has no channel and no chatId/messageId to fall back to`);
  }

  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  // Telegram drops an inline keyboard from any edit that does not re-send
  // it, so every progress line has to carry the ✖️ Stop button along.
  const keyboard = cancelToken ? cancelKeyboard(cancelToken) : undefined;

  return {
    async progress(text) {
      if (statusMessageId) await tg.editMessageText(chatId, statusMessageId, text, keyboard);
      else await tg.sendMessage(chatId, text).catch(() => null);
    },

    // For lines that end the job: the button would have nothing left to stop.
    async settle(text) {
      if (statusMessageId) await tg.editMessageText(chatId, statusMessageId, text);
      else await tg.sendMessage(chatId, text).catch(() => null);
    },

    // Telegram has no separate "error" surface — the status line carries it.
    fail(reason) {
      return this.settle(`❌ Failed: ${reason}`);
    },

    async deliver(load) {
      await tg.sendVideo(chatId, await load(), { replyTo: messageId });
    },

    async offerReview(assetJobId, settings) {
      return sendReviewCard(env, chatId, messageId, assetJobId, settings);
    },

    async offerEdit(assetJobId, settings) {
      await sendEditCard(env, chatId, messageId, assetJobId, settings);
    },
  };
}

/**
 * The webhook channel: an API job has no chat to reply into, so every event
 * is a POST to the `callbackUrl` it was submitted with instead. The finished
 * video is never inlined in the callback body — it can be tens of MB — so
 * `deliver` sends a link to `GET /api/jobs/{id}/output` and leaves the bytes
 * in R2 for the client to fetch (see the `cleanup` step in `workflow.ts`).
 *
 * A failed POST is logged and swallowed rather than thrown: the run itself
 * already succeeded or failed on its own terms, and a client that never gets
 * a callback can still poll `GET /api/jobs/{id}`.
 *
 * `callbackUrl` is optional — an MCP client in a chat has nowhere to receive
 * one — so every line is also recorded for `jobStatus` to read back, which is
 * the only progress a polling client ever sees.
 */
function webhookChannel(env: Env, job: CaptionJob, callbackUrl: string | undefined): Channel {
  const post = async (body: Record<string, unknown>) => {
    const line = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? `❌ Failed: ${body.error}` : null;
    if (line) await recordProgress(env, job.jobId, line);
    if (!callbackUrl) return;
    try {
      const payload = JSON.stringify({ jobId: job.jobId, ...body });
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await callbackSignature(env, payload)) },
        body: payload,
      });
      if (!res.ok) console.error(`[channel] callback for ${job.jobId} rejected: HTTP ${res.status}`);
    } catch (err) {
      console.error(`[channel] callback for ${job.jobId} failed:`, err);
    }
  };

  return {
    async progress(text) {
      await post({ event: 'progress', message: text });
    },

    // Every path here is terminal for a webhook job — review can't pause one
    // (rejected at submission), so this only ever fires on the empty/abandon
    // routes in workflow.ts — which is also why the concurrency slot frees.
    async settle(text) {
      await post({ event: 'stopped', message: text });
      await releaseSlot(env, job.jobId);
    },

    async fail(reason) {
      await post({ event: 'failed', error: reason });
      await releaseSlot(env, job.jobId);
    },

    async deliver() {
      await post({ event: 'completed', message: '✅ Done.', downloadUrl: outputUrl(env, job.jobId) });
      await releaseSlot(env, job.jobId);
    },

    // No script-review card exists over the API — rejected at submission
    // time instead of reaching this, so a stray call just declines it.
    async offerReview() {
      return false;
    },

    // No per-video restyle card over the API yet.
    async offerEdit() {},
  };
}

/**
 * Which `Channel` a job reports through.
 *
 * Unset `channel` means Telegram — every job queued before this field
 * existed was one.
 */
export function channelFor(env: Env, job: CaptionJob): Channel {
  if (job.channel?.type === 'webhook') return webhookChannel(env, job, job.channel.callbackUrl);
  return telegramChannel(env, job);
}
