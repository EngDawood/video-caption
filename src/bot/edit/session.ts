import type { CaptionSettings } from '../../captions/settings';
import type { Env } from '../../types';

/** The KV records behind the per-video cards. Each is written once, never rewritten. */

/** How long a delivered video stays restylable — and stays in R2. */
export const EDIT_TTL_SECONDS = 24 * 60 * 60;

export const editKey = (token: string) => `edit:${token}`;

/** Which video a pasted-back block is correcting. Written once per ✍️ tap. */
export const fixKey = (chatId: number) => `fix:${chatId}`;

export interface FixSession {
  token: string;
  /** The settings the video was burned with, so the re-burn matches it. */
  code: string;
}

/** Written once when the card is posted, so there is no rewrite to race. */
export interface EditSession {
  /** Whose R2 prefix holds the input video, the transcript and the cues. */
  assetJobId: string;
  /** The user's original message, so a re-run replies to it like the first run did. */
  messageId: number;
  /**
   * What the run that produced this video used. The draft is compared against
   * it to work out how much of the pipeline has to happen again.
   */
  settings?: CaptionSettings;
}

/**
 * Park what a later tap needs, and hand back the token that addresses it.
 *
 * Written once and never rewritten, which is what keeps KV's eventual
 * consistency out of the edit flow — the draft itself rides on the buttons.
 */
export async function openSession(env: Env, session: EditSession): Promise<string | null> {
  if (!env.CAPTION_SETTINGS) return null;
  const token = crypto.randomUUID().slice(0, 8);
  await env.CAPTION_SETTINGS.put(editKey(token), JSON.stringify(session), {
    expirationTtl: EDIT_TTL_SECONDS,
  });
  return token;
}
