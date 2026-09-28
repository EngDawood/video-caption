import { describe, expect, it } from 'vitest';
import { pickMode } from '../../src/bot/edit/rerun';
import { decodeSettings, defaults, encodeSettings } from '../../src/captions/settings';
import { buildGlossary } from '../../src/pipeline/translate';
import type { Env, Segment } from '../../src/types';

const env = { TRANSLATION_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' } as unknown as Env;
const base = defaults(env);
const chat = { model: '@cf/test', kind: 'chat' } as const;
const units: Segment[] = [{ start: 0, end: 1, text: 'So I asked Bob Osteen about my complications.' }];

/** An Env whose AI binding answers every call with `reply`, or throws it. */
const answering = (reply: string | Error): Env =>
  ({
    AI: {
      run: async () => {
        if (reply instanceof Error) throw reply;
        return { response: reply };
      },
    },
  }) as unknown as Env;

describe('🎭 Video type setting', () => {
  it('defaults to auto', () => {
    expect(base.genre).toBe('auto');
  });

  it('survives the button code', () => {
    const comedy = { ...base, genre: 'comedy' as const };
    expect(decodeSettings(encodeSettings(comedy), base).genre).toBe('comedy');
  });

  it('reads a code minted before it existed as the chat default', () => {
    const old = encodeSettings({ ...base, genre: 'song' }).slice(0, -1);
    expect(decodeSettings(old, { ...base, genre: 'lecture' }).genre).toBe('lecture');
  });

  it('re-translates when it changes, and only then', () => {
    expect(pickMode(base, { ...base, genre: 'comedy' })).toBe('retranslate');
    expect(pickMode(base, { ...base })).toBe('restyle');
  });

  it('treats settings stored before it existed as auto', () => {
    const { genre: _, ...old } = base;
    expect(pickMode(old as typeof base, base)).toBe('restyle');
  });
});

describe('buildGlossary', () => {
  it('keeps well-formed entries in the target language', async () => {
    const reply = '1. Bob Osteen = بوب أوستين\n- complications → مضاعفات\nsurgeon = surgeon\nsome chatter';
    expect(await buildGlossary(answering(reply), chat, units, 'en', 'ar', 'lecture')).toBe(
      'Bob Osteen = بوب أوستين\ncomplications = مضاعفات',
    );
  });

  it('drops phrases, dialogue and glossed idioms', async () => {
    const reply =
      "You a**hole = أنت خسيس\nCome on, I can take it = هيا، أستطيع التحمل\n" +
      'Lightning in a bottle = برق في زجاجة (idiom: فكرة ناجحة)\nCedric = سيدريك';
    expect(await buildGlossary(answering(reply), chat, units, 'en', 'ar', 'comedy')).toBe('Cedric = سيدريك');
  });

  it('returns nothing for NONE, or when the call fails', async () => {
    expect(await buildGlossary(answering('NONE'), chat, units, 'en', 'ar', 'auto')).toBe('');
    expect(await buildGlossary(answering(new Error('down')), chat, units, 'en', 'ar', 'auto')).toBe('');
  });
});
