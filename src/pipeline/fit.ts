import type { CaptionSettings } from '../captions/settings';
import { charLimitFor } from '../captions/subtitles';
import { sanitize } from '../captions/text';
import type { Segment, VideoMeta } from '../types';

/**
 * Fitting finished cues to a line length. Stored cues stay unfitted; this runs
 * at burn time, so a restyle can re-fit the same text to a new limit.
 */

interface CaptionLimits {
  maxChars: number;
  /**
   * Set only by 📏 Line length 'auto'. A cue also gets no more characters than
   * can be read in the time it is on screen — see `limitFor`.
   */
  charsPerSecond?: number;
}

/** Cues further apart than this are separate thoughts and never merged. */
const MERGE_GAP_SECONDS = 0.35;

/**
 * Reading rate 📏 'auto' fits to, in characters per second of cue time.
 *
 * The broadcast subtitling norm is 15–20 cps; 17 sits in the middle of it.
 */
export const AUTO_CHARS_PER_SECOND = 17;

/** Below this, the rate cap is ignored — it would cut cues to single words. */
const AUTO_CHARS_FLOOR = 16;

/**
 * The limit for one cue: the frame's cap, narrowed by how long the cue is up.
 *
 * Only 'auto' passes a rate, and it is honest about what this buys. Splitting
 * a dense cue in two does not give the viewer more time to read it — each half
 * gets half the span, so the characters-per-second is the same. What it does
 * change is the shape: a line that would flash on screen full-width for half a
 * second becomes two shorter ones, which the eye takes in at a glance instead
 * of scanning. The cap is the geometry, and this only ever tightens it.
 */
function limitFor(limits: CaptionLimits, duration: number): number {
  if (!limits.charsPerSecond || !(duration > 0)) return limits.maxChars;
  const readable = Math.round(duration * limits.charsPerSecond);
  return Math.max(AUTO_CHARS_FLOOR, Math.min(limits.maxChars, readable));
}

/**
 * Re-fit finished cues to a new line length, in either direction.
 *
 * `resegment` only ever splits, so on its own it cannot widen cues that were
 * already broken up at a smaller limit. The restyle flow needs both directions
 * — a user raising the limit expects longer lines — so glue contiguous cues
 * back together first, then split the result as usual.
 */
export function refitSegments(
  segments: Segment[],
  maxChars: number,
  opts: { charsPerSecond?: number } = {},
): Segment[] {
  const limits: CaptionLimits = {
    maxChars: Math.max(12, maxChars || 42),
    charsPerSecond: opts.charsPerSecond,
  };
  const merged: Segment[] = [];

  for (const raw of segments) {
    // Also the backstop for cues already sitting in R2 from before the line
    // above existed, and for text a user has pasted back by hand.
    const segment = { ...raw, text: sanitize(raw.text).replace(/\s+/g, ' ').trim() };
    const previous = merged[merged.length - 1];
    const joined = previous ? `${previous.text} ${segment.text}` : '';

    // Merged against the frame's cap, not the per-cue rate one: this pass only
    // widens, and the split below re-cuts the result at whatever the rate
    // allows. Merging at the tighter number would leave nothing to re-cut.
    if (previous && joined.length <= limits.maxChars && segment.start - previous.end <= MERGE_GAP_SECONDS) {
      previous.text = joined;
      previous.end = segment.end;
      continue;
    }

    merged.push({ ...segment });
  }

  return resegment(merged, limits);
}

/**
 * The cues a burn actually draws: `refitSegments` with the line length this
 * video resolves to.
 *
 * One function because the two callers — the workflow's burn step and the 🖼
 * preview — have to agree exactly. A preview rendered at a different limit
 * from the burn is worse than no preview at all.
 */
export function fitSegments(
  segments: Segment[],
  settings: CaptionSettings,
  meta: Pick<VideoMeta, 'width' | 'height'>,
): Segment[] {
  return refitSegments(
    segments,
    charLimitFor(settings, meta, segments),
    // The reading-rate cap is part of what 'auto' means; a fixed limit is a
    // number the user chose and is left alone.
    settings.chars === 'auto' ? { charsPerSecond: AUTO_CHARS_PER_SECOND } : {},
  );
}

/** Sentence enders, Latin and Arabic (؟ question mark, ۔ full stop). */
export const SENTENCE_END = /[.!?؟۔]$/;
/** Clause breaks — second choice when no sentence boundary fits. */
const CLAUSE_END = /[,;:،؛]$/;

/**
 * Split cues that are too long to read into shorter ones, preferring sentence
 * boundaries, then clause boundaries, then plain word breaks. New timings are
 * interpolated across the original span by character count — close enough at
 * subtitle granularity, and it keeps cues butted up against each other.
 */
export function resegment(segments: Segment[], limits: CaptionLimits): Segment[] {
  const out: Segment[] = [];

  for (const segment of segments) {
    const duration = segment.end - segment.start;
    const maxChars = limitFor(limits, duration);
    const words = segment.text.split(/\s+/).filter(Boolean);

    // Length is the only reason to split. A short line that happens to span a
    // long pause should keep its full timing — truncating it would blank the
    // caption while the speaker is still on that sentence.
    if (segment.text.length <= maxChars) {
      out.push(segment);
      continue;
    }

    // Greedily fill lines, closing early on a sentence/clause boundary once the
    // line is long enough that the break will not look abrupt.
    const chunks: string[] = [];
    let current: string[] = [];

    for (const word of words) {
      const candidate = current.length ? `${current.join(' ')} ${word}` : word;

      if (candidate.length > maxChars && current.length) {
        chunks.push(current.join(' '));
        current = [word];
        continue;
      }

      current.push(word);
      const length = candidate.length;
      const atSentence = SENTENCE_END.test(word);
      const atClause = CLAUSE_END.test(word);

      if ((atSentence && length >= maxChars * 0.4) || (atClause && length >= maxChars * 0.7)) {
        chunks.push(current.join(' '));
        current = [];
      }
    }
    if (current.length) chunks.push(current.join(' '));

    // Spread the original time span over the chunks, weighted by length.
    const total = chunks.reduce((sum, c) => sum + c.length, 0) || 1;
    let cursor = segment.start;

    for (const chunk of chunks) {
      const span = (chunk.length / total) * duration;
      out.push({ start: cursor, end: cursor + span, text: chunk });
      cursor += span;
    }
  }

  return out;
}
