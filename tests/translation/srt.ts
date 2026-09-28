import type { Segment } from '../../src/types';

const TIME = /(\d+):(\d+):(\d+)[,.](\d+)/;

const seconds = (stamp: string): number => {
  const m = TIME.exec(stamp);
  if (!m) throw new Error(`not an SRT timestamp: ${stamp}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
};

/** An .srt file as the segments STT would have handed the translator. */
export function parseSrt(srt: string): Segment[] {
  return srt
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((block) => block.trim().split('\n'))
    .filter((lines) => lines.length >= 2)
    .map((lines) => {
      const timing = lines.findIndex((l) => l.includes('-->'));
      const [from, to] = lines[timing].split('-->');
      return {
        start: seconds(from),
        end: seconds(to),
        text: lines.slice(timing + 1).join(' ').trim(),
      };
    })
    .filter((s) => s.text.length > 0);
}
