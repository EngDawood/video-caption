import { sanitize } from '../../captions/text';
import type { Segment } from '../../types';

/**
 * Reading pasted-back corrections, and matching them to the stored cues.
 * Pure: no Telegram, no KV, no R2.
 */

/** What was said, and what gets burned in. */
export const SOURCE_MARK = '🗣';
export const TARGET_MARK = '💬';

/** Times are copied by hand, so match the closest start within a beat. */
const MATCH_TOLERANCE_SECONDS = 0.6;

const EPSILON = 0.001;

/** SRT form — `00:01:02,400` — the shape people already know from subtitles. */
export function clock(seconds: number): string {
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

/**
 * One space between words, none at the ends.
 *
 * Pasted text arrives with whatever spacing the copy picked up, and doubled
 * spaces in a cue short enough to skip `resegment` are burned in as they are.
 */
const tidy = (text: string) => sanitize(text).replace(/\s+/g, ' ').trim();

/**
 * What a block's text is replaced with to drop the line entirely.
 *
 * Deleting is the one gesture here that destroys text rather than rewording it,
 * so it has to be deliberate: an emptied block means nothing, and only one of
 * these stands for "remove this". The words are there because 🗑 costs a trip
 * through an emoji keyboard on a phone.
 */
const REMOVE_TOKENS = new Set(['🗑', '🗑️', '-', '–', '—', 'delete', 'remove', 'حذف']);

/** One pasted-back block: whichever of the two lines the user kept. */
export interface Correction {
  start: number;
  /** A corrected transcript line, when the 🗣 line was included. */
  source?: string;
  /** A corrected caption, when the 💬 line was included — or left unlabelled. */
  target?: string;
  /** The caption was replaced with a delete token: drop the line. */
  remove?: boolean;
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
  const lines = text.split('\n');
  let current: Correction | null = null;
  let field: 'source' | 'target' | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // An .srt numbers every cue, and blocks copied out of the exported file
    // bring that number with them. Only skipped directly above a timestamp
    // line, so a correction whose text is genuinely a number still lands.
    if (/^\s*\d+\s*$/.test(raw) && BLOCK.test(lines[i + 1] ?? '')) continue;

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

  // Read after the block is whole, so a delete token is recognised wherever it
  // was put — labelled, unlabelled, or trailing on the timestamp line.
  for (const correction of out) {
    if (correction.source !== undefined) correction.source = tidy(correction.source);
    if (correction.target === undefined) continue;

    correction.target = tidy(correction.target);
    if (REMOVE_TOKENS.has(correction.target.toLowerCase())) {
      correction.remove = true;
      delete correction.target;
    }
  }

  return out.filter((c) => c.source !== undefined || c.target !== undefined || c.remove === true);
}

/**
 * The transcript lines a translated cue was built from.
 *
 * `groupForTranslation` merges consecutive segments and keeps the first one's
 * start and the last one's end, so a cue's span always covers a contiguous run
 * of them — containment of the start is enough to recover it.
 */
export function sourceRun(source: Segment[], cue: Segment): Segment[] {
  return source.filter((s) => s.start >= cue.start - EPSILON && s.start < cue.end - EPSILON);
}

/**
 * Put a corrected transcript line back over the run it was shown as.
 *
 * The run collapses to one segment spanning it, which is what
 * `groupForTranslation` would do with it anyway — so a later re-translate sees
 * the correction as the single sentence the user actually edited.
 */
export function replaceSourceRun(source: Segment[], cue: Segment, text: string): void {
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
export function nearestCue(cues: Segment[], start: number): number {
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
