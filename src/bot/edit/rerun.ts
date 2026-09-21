import type { CaptionSettings } from '../../captions/settings';
import { rootKeyboard } from '../menu';
import { telegram } from '../telegram';
import type { CaptionJob, Env, Segment } from '../../types';
import { MENU_TITLE, scopeFor } from './cards';
import type { EditSession } from './session';

/** Queueing a re-run of one delivered video, at the shallowest depth that serves it. */

/**
 * The shallowest re-run that can deliver `draft`.
 *
 * Reading the speech again is the expensive one, so it is reserved for the two
 * settings that actually change what the transcriber does. Everything else is
 * either a translation input or pure styling.
 */
function pickMode(was: CaptionSettings | undefined, draft: CaptionSettings): CaptionJob['mode'] {
  // No record of the original settings (a card posted by an older deploy):
  // re-burn, which is what that card promised anyway.
  if (!was) return 'restyle';
  if (was.stt !== draft.stt || was.sourceLang !== draft.sourceLang) return 'retranscribe';
  if (was.translator !== draft.translator || was.targetLang !== draft.targetLang) return 'retranslate';
  return 'restyle';
}

const WORKING: Record<string, string> = {
  restyle: '⏳ Queued — re-burning…',
  retranslate: '⏳ Queued — translating again…',
  retranscribe: '⏳ Queued — reading the speech again…',
};

/** A short tag derived from the cue text: the same wording is the same run. */
export function revisionOf(segments: Segment[]): string {
  let hash = 0x811c9dc5;
  for (const character of segments.map((s) => s.text).join('\0')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

interface RerunOptions {
  /** Forces the depth where the settings alone cannot imply it. */
  mode?: CaptionJob['mode'];
  /** A tag for the text this run burns, so a rewording is not read as a repeat tap. */
  revision?: string;
}

/**
 * Queue a re-run behind `jobId`, idempotently.
 *
 * `jobId` is deterministic per token+code (see `startRestyle` and the
 * review-timeout auto-continue in `workflow.ts`), so two attempts at the same
 * one — a real double tap, or the auto-continue racing a tap that landed just
 * before it — collide into a single run rather than burning the video twice.
 * `CAPTION_WORKFLOW.create` throws on a colliding id; that is read back with
 * `.get` rather than matched on the error text, which is not part of any
 * contract. Only a genuine failure to queue is rethrown.
 */
export async function queueRestyle(env: Env, jobId: string, params: Omit<CaptionJob, 'jobId'>): Promise<void> {
  try {
    await env.CAPTION_WORKFLOW.create({ id: jobId, params: { jobId, ...params } });
  } catch (err) {
    const existing = await env.CAPTION_WORKFLOW.get(jobId).catch(() => null);
    if (existing) return;
    throw err;
  }
}

/**
 * Queue the re-run, at whatever depth the draft calls for.
 *
 * The workflow id is derived from the token and the draft rather than being
 * random, so a double tap lands on an id that already exists and Workflows
 * refuses it. Every mode here ends in a whole video encode — the one thing
 * that must not happen twice because a button was pressed twice.
 *
 * `revision` extends that to corrected text, which the draft code cannot
 * describe: the same settings burned twice is a repeat tap, but the same
 * settings burned over reworded cues is a run the user is owed.
 */
export async function startRestyle(
  env: Env,
  chatId: number,
  messageId: number,
  callbackId: string,
  token: string,
  code: string,
  session: EditSession,
  settings: CaptionSettings,
  opts: RerunOptions = {},
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const mode = opts.mode ?? pickMode(session.settings, settings);
  const jobId = opts.revision
    ? `fix-${mode}-${token}-${code}-${opts.revision}`
    : `restyle-${token}-${code}`;

  await tg.answerCallbackQuery(callbackId, 'Working…');
  // Buttons come off before the job is queued, so a second tap has nothing
  // left to hit. The card is the status line from here on, and the finished
  // run posts a fresh card of its own.
  await tg.editMessageText(chatId, messageId, WORKING[mode ?? 'restyle']);

  try {
    await queueRestyle(env, jobId, {
      chatId,
      messageId: session.messageId,
      mode,
      assetJobId: session.assetJobId,
      settings,
      statusMessageId: messageId,
    });
  } catch (err) {
    console.error('[edit] could not queue a re-run:', err);
    await tg.editMessageText(
      chatId,
      messageId,
      `⚠️ Could not start that re-run.\n\n${MENU_TITLE}`,
      rootKeyboard(settings, scopeFor(token, settings)),
    );
  }
}
