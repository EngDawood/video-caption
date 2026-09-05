import {
  MENUS,
  decodeSettings,
  defaults,
  encodeSettings,
  type CaptionSettings,
  type SettingsField,
} from '../captions/settings';
import { loadCues, purgeAssets, saveCues } from '../media/assets';
import { fieldKeyboard, readChoice, rootKeyboard, shortLabel, summary, type MenuScope } from './menu';
import { escapeHtml, telegram, type InlineKeyboard } from './telegram';
import type { CaptionJob, Env, Segment } from '../types';

/**
 * Re-running one delivered video.
 *
 * After a job sends its video, it posts a card offering to change anything
 * about it. Editing here never touches the chat defaults — the whole point is
 * to fix one video without changing what the next one looks like.
 *
 * Applying re-runs from the shallowest stage that can serve the change, using
 * what the first run left in R2 (see `pickMode`): a new font is one encode, a
 * new translator re-translates the stored transcript, and a new transcriber or
 * spoken language reads the stored video's speech again. Nothing is ever
 * downloaded twice.
 *
 * The draft rides on the buttons as a compact code (see `encodeSettings`), not
 * in KV. KV is eventually consistent, and a read-modify-write per tap can
 * serve a stale draft and quietly undo changes the user already made. What KV
 * does hold — written once, never rewritten — is which job's files to re-burn.
 *
 * Wording is the one thing a menu cannot fix, so ✍️ Fix text takes corrections
 * as ordinary chat replies (`12 the corrected line`) and writes them straight
 * into the stored cues. No new pipeline depth is needed for that: a `restyle`
 * already burns whatever `segments.json` holds, so correcting the text and
 * re-burning are the same operation the ♻️ Apply button has always performed.
 *
 * callback_data grammar (Telegram caps it at 64 bytes; the longest below is
 * about 40, and a job id is a 36-char UUID, so a short token stands in for it):
 *   e:<token>:<code>              open the draft menu
 *   em:<token>:<code>:<field>     open one field's options ('root' for the top)
 *   es:<token>:<code>:<field>     <code> already carries the new value
 *   eg:<token>:<code>             burn it again with this draft
 *   et:<token>:<code>             list the cues and start taking corrections
 *   ef:<token>:<code>             burn the corrections
 *   er:<token>:<code>             translate a corrected transcript, then burn
 *   ex:<token>                    close, and drop the stored video
 */

/** How long a delivered video stays restylable — and stays in R2. */
const EDIT_TTL_SECONDS = 24 * 60 * 60;

const editKey = (token: string) => `edit:${token}`;

/** Which video a pasted-back block is correcting. Written once per ✍️ tap. */
const fixKey = (chatId: number) => `fix:${chatId}`;

interface FixSession {
  token: string;
  /** The settings the video was burned with, so the re-burn matches it. */
  code: string;
}

/** What was said, and what gets burned in. */
const SOURCE_MARK = '🗣';
const TARGET_MARK = '💬';

/** Telegram refuses a message over 4096 characters. */
const CHUNK_LIMIT = 3500;

/** Times are copied by hand, so match the closest start within a beat. */
const MATCH_TOLERANCE_SECONDS = 0.6;

const EPSILON = 0.001;

/** Written once when the card is posted, so there is no rewrite to race. */
interface EditSession {
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

export function isEditCallback(data: string): boolean {
  return /^e[msgxtfr]?:/.test(data);
}

/** SRT form — `00:01:02,400` — the shape people already know from subtitles. */
function clock(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(
    Math.floor(ms / 1000) % 60,
  )},${pad(ms % 1000, 3)}`;
}

/** Read `00:01:02,400`, `1:02.4` or a bare `62.4` back into seconds. */
function parseClock(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3) return null;

  let seconds = 0;
  for (const part of parts) {
    const value = Number(part.replace(',', '.'));
    if (!Number.isFinite(value)) return null;
    seconds = seconds * 60 + value;
  }
  return seconds;
}

/**
 * The line that opens a block — `00:00:12,400 --> 00:00:15,200` as sent, with
 * the correction either under it or trailing on the same line.
 *
 * Deliberately narrow on both halves, because this predicate is also what
 * decides whether an ordinary chat message is a correction at all: each time
 * needs an internal separator and the arrow needs more than one hyphen, so
 * "12-15 lunch" and "2024–2025 was good" stay ordinary messages.
 */
const BLOCK = /^\s*\[?\s*(\d+(?:[:.,]\d+)+)\s*(?:→|-+>|–|—)\s*(\d+(?:[:.,]\d+)+)\s*\]?\s*(.*)$/u;

const markOf = (line: string): 'source' | 'target' | null =>
  line.startsWith(SOURCE_MARK) ? 'source' : line.startsWith(TARGET_MARK) ? 'target' : null;

// The trailing ️ covers a mark retyped from a keyboard rather than copied:
// most emoji keyboards emit the variation selector, the bot's own text does not.
const unmark = (line: string) => line.replace(/^(?:🗣|💬)️?\s*/u, '').trim();

/** One pasted-back block: whichever of the two lines the user kept. */
interface Correction {
  start: number;
  /** A corrected transcript line, when the 🗣 line was included. */
  source?: string;
  /** A corrected caption, when the 💬 line was included — or left unlabelled. */
  target?: string;
}

/**
 * Read corrections out of an ordinary chat message.
 *
 * Blocks are addressed by their start time rather than by an index, so a user
 * copies a block out of the list, edits the words and sends it back — there is
 * no numbering to keep in sync, and a correction stays valid even after another
 * one has been applied.
 *
 * Returns nothing for a message that carries no timestamped block at all, which
 * is what keeps ordinary chat text out of this path.
 */
export function parseCorrections(text: string): Correction[] {
  const out: Correction[] = [];
  let current: Correction | null = null;
  let field: 'source' | 'target' | null = null;

  for (const raw of text.split('\n')) {
    const header = BLOCK.exec(raw);

    if (header) {
      const start = parseClock(header[1]);
      if (start === null) continue;

      current = { start };
      out.push(current);

      // `[1:02.4 → 1:05.0] the whole correction on one line` is allowed too.
      const trailing = header[3].trim();
      field = null;
      if (trailing) {
        field = markOf(trailing) ?? 'target';
        current[field] = unmark(trailing);
      }
      continue;
    }

    if (!current) continue;
    const line = raw.trim();
    if (!line) continue;

    const mark = markOf(line);
    if (mark) {
      field = mark;
      current[mark] = unmark(line);
      continue;
    }

    // An unlabelled line is the caption: that is the text being burned, and it
    // is what someone retyping a line from scratch means.
    if (field === null) field = 'target';
    current[field] = current[field] ? `${current[field]} ${line}` : line;
  }

  return out.filter((c) => c.source !== undefined || c.target !== undefined);
}

/**
 * The transcript lines a translated cue was built from.
 *
 * `groupForTranslation` merges consecutive segments and keeps the first one's
 * start and the last one's end, so a cue's span always covers a contiguous run
 * of them — containment of the start is enough to recover it.
 */
function sourceRun(source: Segment[], cue: Segment): Segment[] {
  return source.filter((s) => s.start >= cue.start - EPSILON && s.start < cue.end - EPSILON);
}

/**
 * Put a corrected transcript line back over the run it was shown as.
 *
 * The run collapses to one segment spanning it, which is what
 * `groupForTranslation` would do with it anyway — so a later re-translate sees
 * the correction as the single sentence the user actually edited.
 */
function replaceSourceRun(source: Segment[], cue: Segment, text: string): void {
  const run = sourceRun(source, cue);

  if (run.length === 0) {
    source.push({ start: cue.start, end: cue.end, text });
    source.sort((a, b) => a.start - b.start);
    return;
  }

  source.splice(source.indexOf(run[0]), run.length, {
    start: run[0].start,
    end: run[run.length - 1].end,
    text,
  });
}

/** The cue a hand-copied start time refers to, or -1 if it matches nothing. */
function nearestCue(cues: Segment[], start: number): number {
  let best = -1;
  let closest = MATCH_TOLERANCE_SECONDS;

  cues.forEach((cue, index) => {
    const gap = Math.abs(cue.start - start);
    if (gap <= closest) {
      best = index;
      closest = gap;
    }
  });

  return best;
}

/**
 * One segment, as a block the user can copy in a single tap.
 *
 * <pre> is what buys that: Telegram renders it monospaced with a copy button,
 * so correcting a line is copy, edit the words, send — and the timestamps come
 * back untouched, which is how the correction finds its way home.
 */
const blockFor = (cue: Segment, source: string) =>
  `<pre>${escapeHtml(
    [
      `${clock(cue.start)} --> ${clock(cue.end)}`,
      ...(source ? [`${SOURCE_MARK} ${source}`] : []),
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

const FIX_HELP = [
  '✍️ Every line in this video, with its times.',
  '',
  `${SOURCE_MARK} what was said · ${TARGET_MARK} what gets burned in`,
  '',
  'Tap a block to copy it, fix the wording, and send it back. Keep the timestamps as they are — that is how I find the line to replace. Several blocks in one message is fine.',
  '',
  'Then tap ♻️ Burn the fixes.',
].join('\n');

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

const scopeFor = (token: string, settings: CaptionSettings): MenuScope => ({
  open: (field) => `em:${token}:${encodeSettings(settings)}:${field}`,
  // The code carries the value; the field name rides along only so the tap can
  // be acknowledged with the name of what just changed.
  pick: (field, value) =>
    `es:${token}:${encodeSettings({ ...settings, [field]: value } as CaptionSettings)}:${field}`,
  footer: [
    [
      { text: '♻️ Apply', callback_data: `eg:${token}:${encodeSettings(settings)}` },
      { text: '✖️ Close', callback_data: `ex:${token}` },
    ],
  ],
});

const CARD_TITLE = '🎬 Captioned with:';
const MENU_TITLE =
  '✏️ Editing this video only\n\nChange what you like, then tap ♻️ Apply.\nYour chat defaults are untouched.';

/**
 * Offer to change the video that was just delivered.
 *
 * The settings this run used go into the session, because that is what a later
 * tap is compared against to decide how much has to happen again.
 *
 * Best-effort: a job that has already sent its video must not be marked failed
 * because the follow-up card did not post.
 */
export async function sendEditCard(
  env: Env,
  chatId: number,
  messageId: number,
  assetJobId: string,
  settings: CaptionSettings,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);

  if (!env.CAPTION_SETTINGS) return;

  const token = crypto.randomUUID().slice(0, 8);

  try {
    await env.CAPTION_SETTINGS.put(
      editKey(token),
      JSON.stringify({ assetJobId, messageId, settings } satisfies EditSession),
      { expirationTtl: EDIT_TTL_SECONDS },
    );

    const code = encodeSettings(settings);
    const keyboard: InlineKeyboard = [
      [
        { text: '✏️ Edit', callback_data: `e:${token}:${code}` },
        { text: '✍️ Fix text', callback_data: `et:${token}:${code}` },
      ],
      [{ text: '✖️ Cancel', callback_data: `ex:${token}` }],
    ];
    await tg.sendMessage(chatId, `${CARD_TITLE}\n${summary(settings)}`, messageId, keyboard);
  } catch (err) {
    console.error('[edit] could not offer a restyle:', err);
  }
}

/** Handle a tap anywhere in the per-video edit flow. */
export async function handleEditCallback(
  env: Env,
  chatId: number,
  messageId: number,
  callbackId: string,
  data: string,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const [verb, token, code, rawField] = data.split(':');

  const session = env.CAPTION_SETTINGS
    ? await env.CAPTION_SETTINGS.get<EditSession>(editKey(token), 'json')
    : null;

  if (!session) {
    await tg.answerCallbackQuery(callbackId, 'That video has expired — send it again to caption it fresh.');
    await tg.editMessageText(chatId, messageId, '⌛ Expired.');
    return;
  }

  // Close needs no draft, and its button carries none.
  if (verb === 'ex') {
    // The stored video is what makes a restyle cheap, and it is no longer
    // wanted, so it goes now rather than waiting out the TTL.
    await env.CAPTION_SETTINGS?.delete(editKey(token)).catch(() => {});
    // Only if it still points here: another video's ✍️ list may have opened
    // since, and closing this card must not silence that one.
    const fix = await env.CAPTION_SETTINGS?.get<FixSession>(fixKey(chatId), 'json').catch(() => null);
    if (fix?.token === token) await env.CAPTION_SETTINGS?.delete(fixKey(chatId)).catch(() => {});
    await purgeAssets(env, session.assetJobId);
    await tg.answerCallbackQuery(callbackId, 'Closed');
    await tg.editMessageText(chatId, messageId, '✅ Closed. That video is no longer stored.');
    return;
  }

  // The code carries all seven fields, so the deployed defaults are only a
  // structural floor for a truncated or corrupted one — no KV read per tap.
  const settings = decodeSettings(code ?? '', defaults(env));
  const scope = scopeFor(token, settings);

  switch (verb) {
    case 'e': {
      await tg.answerCallbackQuery(callbackId);
      await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(settings, scope));
      return;
    }

    case 'em': {
      if (rawField === 'root') {
        await tg.answerCallbackQuery(callbackId);
        await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(settings, scope));
        return;
      }

      const field = rawField as SettingsField;
      if (!MENUS[field]) return void (await tg.answerCallbackQuery(callbackId));
      await tg.answerCallbackQuery(callbackId);
      await tg.editMessageText(
        chatId,
        messageId,
        `${MENUS[field].icon} ${MENUS[field].label}`,
        fieldKeyboard(field, settings, scope),
      );
      return;
    }

    case 'es': {
      // The code already holds the new value, so there is nothing to save —
      // just acknowledge which field moved and redraw the top level.
      const field = readChoice(rawField ?? '', settings[rawField as SettingsField] ?? '');
      if (!field) return void (await tg.answerCallbackQuery(callbackId, 'Unknown option'));

      await tg.answerCallbackQuery(callbackId, `${MENUS[field].label}: ${shortLabel(field, settings[field])}`);
      await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(settings, scope));
      return;
    }

    case 'eg':
      return startRestyle(env, chatId, messageId, callbackId, token, code, session, settings);

    case 'et':
      return startFix(env, chatId, callbackId, token, code, session);

    case 'ef':
    case 'er': {
      // Derived from the text as it stands now rather than from the button, so
      // the ♻️ under an earlier correction still burns the latest wording — and
      // two taps on the same wording still collide into one run.
      const stored = await loadCues(env, session.assetJobId);
      if (!stored) {
        await tg.answerCallbackQuery(callbackId, 'That video is no longer stored.');
        return;
      }

      // A corrected transcript is only worth anything once it has been through
      // the translator again, so that tap forces the depth rather than letting
      // `pickMode` read unchanged settings and choose a plain re-burn.
      const source = stored.source ?? [];
      if (verb === 'er' && source.length === 0) {
        await tg.answerCallbackQuery(callbackId, 'No stored transcript for this video.');
        return;
      }

      return startRestyle(env, chatId, messageId, callbackId, token, code, session, settings, {
        mode: verb === 'er' ? 'retranslate' : undefined,
        revision: revisionOf(verb === 'er' ? source : stored.segments),
      });
    }

    default:
      await tg.answerCallbackQuery(callbackId);
  }
}

/** A short tag derived from the cue text: the same wording is the same run. */
function revisionOf(segments: Segment[]): string {
  let hash = 0x811c9dc5;
  for (const character of segments.map((s) => s.text).join(' ')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Post the transcript and the translation as copyable blocks, and remember
 * which video the replies are correcting.
 *
 * The pointer is per chat and written once per tap, never read-modify-written,
 * so there is no stale-draft race of the kind the button codes exist to avoid.
 */
async function startFix(
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
  const missed: string[] = [];
  let transcriptChanged = false;

  for (const correction of corrections) {
    const index = nearestCue(stored.segments, correction.start);
    if (index < 0) {
      missed.push(clock(correction.start));
      continue;
    }

    const cue = stored.segments[index];
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
    blockFor(
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

  await say(
    `✍️ Updated ${patched.length} line${patched.length === 1 ? '' : 's'}:\n\n${shown.join('\n')}${trouble}${note}`,
    keyboard,
  );
  return true;
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
interface RerunOptions {
  /** Forces the depth where the settings alone cannot imply it. */
  mode?: CaptionJob['mode'];
  /** A tag for the text this run burns, so a rewording is not read as a repeat tap. */
  revision?: string;
}

async function startRestyle(
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
    await env.CAPTION_WORKFLOW.create({
      id: jobId,
      params: {
        jobId,
        chatId,
        messageId: session.messageId,
        mode,
        assetJobId: session.assetJobId,
        settings,
        statusMessageId: messageId,
      },
    });
  } catch (err) {
    // Ask whether it is already there rather than matching on the error text,
    // which is not part of any contract. If it is, the status line above is
    // already telling the truth and there is nothing to undo.
    const existing = await env.CAPTION_WORKFLOW.get(jobId).catch(() => null);
    if (existing) return;

    console.error('[edit] could not queue a re-run:', err);
    await tg.editMessageText(
      chatId,
      messageId,
      `⚠️ Could not start that re-run.\n\n${MENU_TITLE}`,
      rootKeyboard(settings, scopeFor(token, settings)),
    );
  }
}
