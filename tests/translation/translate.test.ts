import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupForTranslation, isPlausible, leakedWords } from '../../src/pipeline/translate';
import { stripWrapper } from '../../src/pipeline/translators';
import type { Segment } from '../../src/types';
import { SAMPLES } from './samples';
import { parseSrt } from './srt';

const sample = (file: string): Segment[] =>
  parseSrt(readFileSync(new URL(`./samples/${file}`, import.meta.url), 'utf8'));

const seg = (start: number, end: number, text: string): Segment => ({ start, end, text });

describe('parseSrt', () => {
  it('reads every sample', () => {
    for (const { file } of SAMPLES) expect(sample(file).length).toBeGreaterThan(5);
  });

  it('keeps timings and text', () => {
    expect(sample('script-6.srt')[12]).toEqual({ start: 18.9, end: 19.3, text: "I've got it." });
  });
});

describe('groupForTranslation', () => {
  it('loses and reorders no text, on every sample', () => {
    for (const { file } of SAMPLES) {
      const segments = sample(file);
      const units = groupForTranslation(segments);
      expect(units.map((u) => u.text).join(' ')).toBe(segments.map((s) => s.text).join(' '));
      for (let i = 1; i < units.length; i++) expect(units[i].start).toBeGreaterThanOrEqual(units[i - 1].end);
    }
  });

  it('keeps every unit under the cap unless one segment is longer on its own', () => {
    for (const { file } of SAMPLES) {
      const longest = Math.max(...sample(file).map((s) => s.text.length));
      for (const u of groupForTranslation(sample(file))) {
        expect(u.text.length).toBeLessThanOrEqual(Math.max(400, longest));
      }
    }
  });

  it('joins fragments that run on with no punctuation or pause', () => {
    const units = groupForTranslation([seg(0, 1, 'So I asked a former'), seg(1, 2, 'professor of mine.')]);
    expect(units.map((u) => u.text)).toEqual(['So I asked a former professor of mine.']);
  });

  it('splits on a long pause even mid-sentence', () => {
    const units = groupForTranslation([seg(0, 1, 'I said'), seg(3, 4, 'free Palestine')]);
    expect(units).toHaveLength(2);
  });

  it('rewinds a forced break to the last sentence end', () => {
    const long = 'word '.repeat(70).trim();
    const units = groupForTranslation([
      seg(0, 1, `${long}.`),
      seg(1, 2, 'and then the sentence'),
      seg(2, 3, `carries on ${long}`),
    ]);
    expect(units[0].text.endsWith('.')).toBe(true);
    expect(units[1].text.startsWith('and then the sentence carries on')).toBe(true);
  });
});

describe('isPlausible', () => {
  it('accepts Arabic, with names in Latin', () => {
    expect(isPlausible('سألت أستاذي السابق Bob Osteen', 'ar')).toBe(true);
  });

  it('rejects CJK or Cyrillic leaked into Arabic', () => {
    expect(isPlausible('هذا أمر 几乎 مستحيل', 'ar')).toBe(false);
    expect(isPlausible('لآخرين вещан', 'ar')).toBe(false);
  });

  it('rejects an answer left in English', () => {
    expect(isPlausible('I have everything I want in life', 'ar')).toBe(false);
  });

  it('does not check a target it has no script for', () => {
    expect(isPlausible('anything at all', 'xx')).toBe(true);
  });
});

describe('leakedWords', () => {
  it('names a third-script word', () => {
    expect(leakedWords('هناك вещан متميزتان', 'there are two', 'ar')).toEqual(['вещан']);
  });

  it('names an English word left in, but not a name or brand', () => {
    expect(leakedWords('اشتريت iPhone من Apple وكان awesome', 'I bought an iPhone from Apple, awesome', 'ar')).toEqual([
      'awesome',
    ]);
  });

  it('names a capitalised word the source used in lowercase', () => {
    expect(leakedWords('Actually هذا صحيح', 'Actually, it is actually true', 'ar')).toEqual(['Actually']);
  });

  it('names a Persian word written in Arabic letters', () => {
    expect(leakedWords('این کتاب جيد', 'this book is good', 'ar')).toEqual(['این', 'کتاب']);
  });
});

describe('stripWrapper', () => {
  it('takes off labels and quotes', () => {
    expect(stripWrapper('TRANSLATION: «مرحبا»')).toBe('مرحبا');
    expect(stripWrapper('"hello"')).toBe('hello');
  });
});
