import type { Env } from '../types';

/**
 * Notes about the shows a chat translates, read by the 📣 post writer.
 *
 * A model knows a famous show only vaguely and an obscure one not at all, and
 * the transcript rarely says which show it is. The user does know, and
 * translates the same shows again and again, so a note is saved once under the
 * show's name and attached to any video whose original post names that show.
 * Post text only: the translator has its own 🎭 type and glossary.
 */

export type Shows = Record<string, string>;

export const MAX_SHOWS = 30;
export const MAX_NOTE_CHARS = 800;
const MAX_NAME_CHARS = 60;

const key = (chatId: number) => `shows:${chatId}`;

export async function loadShows(env: Env, chatId: number): Promise<Shows> {
  if (!env.CAPTION_SETTINGS) return {};
  try {
    return (await env.CAPTION_SETTINGS.get<Shows>(key(chatId), 'json')) ?? {};
  } catch (err) {
    console.error('[shows] load failed:', err);
    return {};
  }
}

async function saveShows(env: Env, chatId: number, shows: Shows): Promise<void> {
  if (!env.CAPTION_SETTINGS) throw new Error('CAPTION_SETTINGS KV namespace is not bound');
  await env.CAPTION_SETTINGS.put(key(chatId), JSON.stringify(shows));
}

/** Case, accents and punctuation must not stop "impractical jokers" matching "IMPRACTICAL JOKERS:". */
const fold = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * The note for the first saved show whose name appears in `texts` (the post's
 * caption, the poster's handle), or null. The longest name wins, so "Impractical
 * Jokers Inside Jokes" is not shadowed by "Impractical Jokers".
 */
export function findShow(shows: Shows, texts: Array<string | null | undefined>): string | null {
  const folded = fold(texts.filter(Boolean).join(' '));
  const haystack = ` ${folded} `;
  // A handle runs the words together (@ImpracticalJokers), so a spaceless
  // match counts too, but only for names long enough not to hit by accident.
  const squashed = folded.replace(/ /g, '');
  const names = Object.keys(shows).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const needle = fold(name);
    if (!needle) continue;
    if (haystack.includes(` ${needle} `)) return name;
    const joined = needle.replace(/ /g, '');
    if (joined.length >= 8 && squashed.includes(joined)) return name;
  }
  return null;
}

export function matchShow(shows: Shows, texts: Array<string | null | undefined>): string | null {
  const name = findShow(shows, texts);
  return name === null ? null : shows[name];
}

/**
 * A short, stable id for a show's button. An index would point at the wrong
 * show once one is added or removed under an open card; a hash of the name
 * does not. Six base-36 digits keep `ew:<token>:<id>` far under 64 bytes.
 */
export function showId(name: string): string {
  let h = 5381;
  for (const ch of fold(name)) h = (Math.imul(h, 33) + ch.codePointAt(0)!) >>> 0;
  return h.toString(36).padStart(6, '0').slice(-6);
}

const USAGE = [
  '🎬 Shows: notes the 📣 post writer reads when a video\'s original post names the show.',
  '',
  'Save or replace one:',
  '/shows Impractical Jokers: four friends dare each other on hidden camera; whoever loses takes the punishment.',
  '',
  'Remove one:',
  '/shows remove Impractical Jokers',
  '',
  'Send /shows alone to list what is saved.',
].join('\n');

/**
 * The /shows command: list, save, or remove. Returns the reply text.
 * `args` is everything after the command.
 */
export async function handleShowsCommand(env: Env, chatId: number, args: string): Promise<string> {
  if (!env.CAPTION_SETTINGS) return '⚠️ Saving shows needs the CAPTION_SETTINGS KV namespace.';
  const text = args.trim();
  const shows = await loadShows(env, chatId);

  if (!text) {
    const names = Object.keys(shows);
    if (names.length === 0) return `No shows saved yet.\n\n${USAGE}`;
    return [`🎬 Saved shows (${names.length}):`, ...names.map((n) => `• ${n}: ${shows[n]}`), '', USAGE].join('\n');
  }

  const remove = /^(?:remove|delete)\s+(.+)$/i.exec(text);
  if (remove) {
    const target = Object.keys(shows).find((n) => fold(n) === fold(remove[1]));
    if (!target) return `No saved show named "${remove[1].trim()}".`;
    delete shows[target];
    await saveShows(env, chatId, shows);
    return `🗑 Removed ${target}.`;
  }

  const split = text.indexOf(':');
  const name = split > 0 ? text.slice(0, split).trim() : '';
  const note = split > 0 ? text.slice(split + 1).trim() : '';
  if (!name || !note) return `Write it as "Show name: what the model should know".\n\n${USAGE}`;
  if (name.length > MAX_NAME_CHARS) return `⚠️ The show name is over ${MAX_NAME_CHARS} characters.`;
  if (note.length > MAX_NOTE_CHARS) return `⚠️ The note is ${note.length} characters; the limit is ${MAX_NOTE_CHARS}.`;

  const existing = Object.keys(shows).find((n) => fold(n) === fold(name));
  if (!existing && Object.keys(shows).length >= MAX_SHOWS) return `⚠️ ${MAX_SHOWS} shows is the limit. Remove one first.`;
  if (existing) delete shows[existing];
  shows[name] = note;
  await saveShows(env, chatId, shows);
  return `${existing ? '✏️ Updated' : '✅ Saved'} ${name}. Videos whose post names it get this note in their 📣 post text.`;
}
