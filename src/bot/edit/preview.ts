import type { CaptionSettings } from '../../captions/settings';
import { buildAssForSettings } from '../../captions/subtitles';
import { fitSegments } from '../../pipeline/fit';
import { assetKeys, loadCues } from '../../media/assets';
import { ffmpegFor } from '../../media/ffmpeg';
import { telegram } from '../telegram';
import type { Env, StoredCues } from '../../types';
import { clock } from './corrections';
import type { EditSession } from './session';

/** One burned frame, rendered in a container of its own. */

export const previewCaption = (at: number) =>
  `🖼 One frame near ${clock(at)} — not the finished video, just this style on it.`;

/**
 * Burn just the first caption onto one frame — a look at how the style will
 * actually render without paying for the full-video encode that ✅ Burn it /
 * ♻️ Apply would run.
 *
 * Runs its own dedicated container instance rather than whatever the workflow
 * used, since neither card carries the original job id and the workflow's own
 * instance is long stopped by the time either card is on screen. Cleaned up
 * immediately after: an idle preview container bills the same as a working
 * one, and the next real burn re-uploads the video anyway.
 *
 * The cues go through `fitSegments`, the same call the burn makes, so a
 * preview cannot show a line length the finished video will not have.
 *
 * Returns null on any failure — both callers treat a missing frame as
 * something to work around, not an error to fail the job with.
 */
export async function renderPreview(
  env: Env,
  assetJobId: string,
  settings: CaptionSettings,
  stored: StoredCues,
): Promise<{ frame: ArrayBuffer; at: number } | null> {
  const ffmpeg = ffmpegFor(env, `preview-${assetJobId}`);
  try {
    const cues = fitSegments(stored.segments, settings, stored.meta);
    const first = cues[0];
    if (!first) throw new Error('no cues to preview');

    const duration = stored.meta.duration || first.end;
    const at = Math.min((first.start + first.end) / 2, Math.max(0, duration - 0.05));

    const video = await env.MEDIA.get(assetKeys(assetJobId).input);
    if (!video) throw new Error('video no longer stored');

    await ffmpeg.uploadVideo(video, { skipAudio: true });
    await ffmpeg.putSubtitles(buildAssForSettings(cues, settings, stored.meta));
    return { frame: await ffmpeg.previewFrame(at), at };
  } catch (err) {
    console.error('[edit] could not render a preview:', err);
    return null;
  } finally {
    await ffmpeg.cleanup();
  }
}

/** The 🖼 Preview button on either card. */
export async function sendPreview(
  env: Env,
  chatId: number,
  callbackId: string,
  session: EditSession,
  settings: CaptionSettings,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const stored = await loadCues(env, session.assetJobId);

  if (!stored || stored.segments.length === 0) {
    await tg.answerCallbackQuery(callbackId, 'The text for that video is no longer stored.');
    return;
  }

  await tg.answerCallbackQuery(callbackId, 'Rendering a preview…');
  const shot = await renderPreview(env, session.assetJobId, settings, stored);

  if (!shot) {
    await tg.sendMessage(chatId, '⚠️ Could not render a preview for that video.').catch(() => null);
    return;
  }

  await tg.sendPhotoFile(chatId, shot.frame, { caption: previewCaption(shot.at) });
}
