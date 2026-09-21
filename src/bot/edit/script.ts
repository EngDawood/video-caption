import { sanitize } from '../../captions/text';
import { loadCues, saveCues } from '../../media/assets';
import { escapeHtml, telegram, type InlineKeyboard } from '../telegram';
import type { Env, Segment, StoredCues } from '../../types';
import {
  SOURCE_MARK,
  TARGET_MARK,
  clock,
  nearestCue,
  parseCorrections,
  replaceSourceRun,
  sourceRun,
} from './corrections';
import { EDIT_TTL_SECONDS, editKey, fixKey, type EditSession, type FixSession } from './session';

/** The script as text: the .srt, the ✍️ copyable list, and applying what comes back. */

/** Telegram refuses a message over 4096 characters. */
const CHUNK_LIMIT = 3500;

/**
 * One segment, as a block the user can copy in a single tap.
 *
 * <pre> is what buys that: Telegram renders it monospaced with a copy button,
 * so correcting a line is copy, edit the words, send — and the timestamps come
 * back untouched, which is how the correction finds its way home. Under 🌐
 * Original the transcript and the burned text are the same words, so the 🗣
 * line would only repeat the 💬 one and is left out.
 */
const blockFor = (cue: Segment, source: string) =>
  `<pre>${escapeHtml(
    [
      `${clock(cue.start)} --> ${clock(cue.end)}`,
      ...(source && source !== cue.text ? [`${SOURCE_MARK} ${source}`] : []),
      `${TARGET_MARK} ${cue.text}`,
    ].join('\n'),
  )}</pre>`;

/** Split into sendable messages without ever cutting a block in half. */
function chunk(blocks: string[]): string[] {
  const out: string[] = [];
  let buffer = '';

  for (const block of blocks) {
    if (buffer && buffer.length + block.length + 2 > CHUNK_LIMIT) {
      out.push(buffer);
      buffer = block;
    } else {
      buffer = buffer ? `${buffer}\n\n${block}` : block;
    }
  }

  if (buffer) out.push(buffer);
  return out;
}

/**
 * The whole script as an .srt.
 *
 * Both languages, because checking a translation means reading it against what
 * was said. The 🗣/💬 marks are the same ones the ✍️ list uses, so a block
 * copied out of this file can be corrected and sent straight back — which is
 * also why the cues are the stored ones rather than the burned ones: the
 * timestamps a correction is matched on are these.
 */
export function buildSrt(stored: StoredCues): string {
  const source = stored.source ?? [];

  const blocks = stored.segments.map((cue, index) => {
    const said = sourceRun(source, cue)
      .map((s) => s.text)
      .join(' ');

    return [
      String(index + 1),
      `${clock(cue.start)} --> ${clock(cue.end)}`,
      ...(said ? [`${SOURCE_MARK} ${said}`] : []),
      // Sanitised so the file shows what the burn will actually draw, not what
      // a translator happened to emit — see `sanitize`.
      `${TARGET_MARK} ${sanitize(cue.text)}`,
    ].join('\n');
  });

  return `${blocks.join('\n\n')}\n`;
}

const SCRIPT_CAPTION = [
  '📄 The script for this video.',
  '',
  `${SOURCE_MARK} what was said · ${TARGET_MARK} what gets burned in`,
  '',
  'Lines are whole sentences here — the burn splits them to your line length.',
].join('\n');

/** Send the script as a file. Returns false when there is nothing left to send. */
export async function sendScript(env: Env, chatId: number, assetJobId: string): Promise<boolean> {
  const stored = await loadCues(env, assetJobId);
  if (!stored || stored.segments.length === 0) return false;

  await telegram(env.TELEGRAM_BOT_TOKEN).sendDocument(chatId, 'script.srt', buildSrt(stored), {
    caption: SCRIPT_CAPTION,
  });
  return true;
}

const FIX_HELP = [
  '✍️ Every line in this video, with its times.',
  '',
  `${SOURCE_MARK} what was said · ${TARGET_MARK} what gets burned in`,
  '',
  'Tap a block to copy it, fix the wording, and send it back. Keep the timestamps as they are — that is how I find the line to replace. Several blocks in one message is fine.',
  '',
  'To drop a line entirely, send its block with 🗑 — or just a dash — in place of the text.',
  '',
  'Then tap ♻️ Burn the fixes.',
].join('\n');

/**
 * Post the transcript and the translation as copyable blocks, and remember
 * which video the replies are correcting.
 *
 * The pointer is per chat and written once per tap, never read-modify-written,
 * so there is no stale-draft race of the kind the button codes exist to avoid.
 */
export async function startFix(
  env: Env,
  chatId: number,
  callbackId: string,
  token: string,
  code: string,
  session: EditSession,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const stored = await loadCues(env, session.assetJobId);

  if (!stored || stored.segments.length === 0) {
    await tg.answerCallbackQuery(callbackId, 'The text for that video is no longer stored.');
    return;
  }

  const source = stored.source ?? [];
  const blocks = stored.segments.map((cue) =>
    blockFor(
      cue,
      sourceRun(source, cue)
        .map((s) => s.text)
        .join(' '),
    ),
  );

  await env.CAPTION_SETTINGS?.put(fixKey(chatId), JSON.stringify({ token, code } satisfies FixSession), {
    expirationTtl: EDIT_TTL_SECONDS,
  }).catch(() => {});

  await tg.answerCallbackQuery(callbackId);

  try {
    await tg.sendMessage(chatId, FIX_HELP);
    for (const part of chunk(blocks)) await tg.sendMessage(chatId, part, undefined, undefined, 'HTML');
  } catch (err) {
    console.error('[edit] could not post the cue list:', err);
  }
}

/**
 * Apply a pasted-back block, if that is what this message is.
 *
 * Returns false for anything that is not a correction — including a correction
 * sent when no ✍️ list is open — so the caller falls through to its ordinary
 * handling. A message has to carry a timestamped block to get this far, which
 * is what keeps normal chat out of the way.
 */
export async function handleTextCorrection(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
): Promise<boolean> {
  const corrections = parseCorrections(text);
  if (corrections.length === 0 || !env.CAPTION_SETTINGS) return false;

  const fix = await env.CAPTION_SETTINGS.get<FixSession>(fixKey(chatId), 'json');
  if (!fix) return false;

  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const say = (body: string, keyboard?: InlineKeyboard) =>
    tg.sendMessage(chatId, body, messageId, keyboard, 'HTML').catch(() => null);

  const session = await env.CAPTION_SETTINGS.get<EditSession>(editKey(fix.token), 'json');
  const stored = session ? await loadCues(env, session.assetJobId) : null;

  if (!session || !stored) {
    await env.CAPTION_SETTINGS.delete(fixKey(chatId)).catch(() => {});
    await say('⌛ That video is no longer stored — send it again to caption it fresh.');
    return true;
  }

  const source = stored.source ?? [];
  const patched: Segment[] = [];
  // Held as cue objects, not indices: every removal shifts the ones after it,
  // and the corrections in one message are all addressed against the list as
  // the user was shown it.
  const doomed = new Set<Segment>();
  const missed: string[] = [];
  let transcriptChanged = false;

  for (const correction of corrections) {
    const index = nearestCue(stored.segments, correction.start);
    if (index < 0) {
      missed.push(clock(correction.start));
      continue;
    }

    const cue = stored.segments[index];

    if (correction.remove) {
      doomed.add(cue);
      patched.push(cue);
      continue;
    }

    if (correction.target) cue.text = correction.target;
    // Only ever amend a transcript that exists. Seeding one from a single
    // hand-typed line would leave a re-translate with one line to work from,
    // and it would replace every caption in the video with that line.
    if (correction.source && source.length > 0) {
      replaceSourceRun(source, cue, correction.source);
      transcriptChanged = true;
    }
    patched.push(cue);
  }

  if (patched.length === 0) {
    await say(`⚠️ Nothing starts at ${missed.join(', ')}. Copy a block from the list and keep its timestamps.`);
    return true;
  }

  // A video with no cues at all is not a correction anyone means to make, and
  // it is the one shape of this that the burn has never been run against.
  if (doomed.size > 0 && doomed.size >= stored.segments.length) {
    await say('⚠️ That would delete every line. Leave at least one, or close the card to drop the video.');
    return true;
  }

  if (doomed.size > 0) {
    // The transcript goes with it, so that a later re-translate cannot bring a
    // deleted line back.
    for (const cue of doomed) {
      const run = sourceRun(source, cue);
      if (run.length > 0) source.splice(source.indexOf(run[0]), run.length);
    }
    stored.segments = stored.segments.filter((cue) => !doomed.has(cue));
  }

  if (source.length > 0) stored.source = source;
  await saveCues(env, session.assetJobId, stored);

  // Correcting what was *said* only reaches the video through the translator,
  // so that case is offered its own button rather than being silently burned
  // as a re-run that could not use it.
  const keyboard: InlineKeyboard = [
    [{ text: '♻️ Burn the fixes', callback_data: `ef:${fix.token}:${fix.code}` }],
    ...(transcriptChanged
      ? [[{ text: '🌐 Translate again, then burn', callback_data: `er:${fix.token}:${fix.code}` }]]
      : []),
  ];

  const shown = patched.map((cue) =>
    doomed.has(cue)
      ? `🗑 <s>${escapeHtml(`${clock(cue.start)} ${cue.text}`)}</s>`
      : blockFor(
          cue,
          sourceRun(source, cue)
            .map((s) => s.text)
            .join(' '),
        ),
  );
  const trouble = missed.length > 0 ? `\n⚠️ Nothing starts at ${missed.join(', ')}.` : '';
  const note = transcriptChanged
    ? '\nTranslating again replaces every caption, including ones you fixed by hand.'
    : '';

  const kept = patched.length - doomed.size;
  const headline = [
    kept > 0 ? `updated ${kept} line${kept === 1 ? '' : 's'}` : '',
    doomed.size > 0 ? `deleted ${doomed.size}` : '',
  ]
    .filter(Boolean)
    .join(', ');

  await say(`✍️ ${headline[0].toUpperCase()}${headline.slice(1)}:\n\n${shown.join('\n')}${trouble}${note}`, keyboard);
  return true;
}
