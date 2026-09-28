/**
 * The translation eval's sample scripts, with what each one tests.
 *
 * `checks` are the regressions a fluent-but-wrong translation must not slip
 * past. Each names a phrase in the source, and the unit containing it has to
 * match `must` and must not match `mustNot`. They are addressed by source text,
 * not by index, so they survive a change to how cues are grouped into units.
 * Keep them to meaning errors a reviewer would agree on, not style.
 *
 * `notes` go to the judge as well as the report: the scripts are real STT
 * output, so some errors are in the source and not the translator's fault.
 */

export interface Check {
  source: string;
  must?: RegExp;
  mustNot?: RegExp;
  why: string;
}

export interface Sample {
  file: string;
  title: string;
  source: string;
  notes?: string;
  checks: Check[];
}

export const SAMPLES: Sample[] = [
  {
    file: 'script-1.srt',
    title: 'TED-style talk: a surgeon on coaching',
    source: 'en',
    notes: 'Cue 14 starts mid-sentence (STT dropped "I imagined having to").',
    checks: [
      {
        source: 'my complications drop',
        must: /مضاعفات/,
        why: 'surgical complications are مضاعفات, not تعقيدات',
      },
      { source: 'Bob Osteen', must: /أوستين|أوستن|أوستِن/, why: 'names are transliterated into Arabic letters' },
    ],
  },
  {
    file: 'script-2.srt',
    title: 'Concert speech on Palestine',
    source: 'en',
    checks: [
      { source: 'occupied West Bank', must: /الضفة/, why: 'West Bank is الضفة الغربية' },
      { source: 'organization, ICE', must: /الهجرة|آيس|أيس/, why: 'ICE is the US immigration agency, in Arabic letters' },
      { source: 'organization, ICE', mustNot: /جليد|ثلج/, why: 'ICE translated as frozen water' },
    ],
  },
  {
    file: 'script-3.srt',
    title: 'Interview: wealth and happiness',
    source: 'en',
    checks: [
      { source: 'drive me crazy', mustNot: /يقود/, why: 'idiom translated literally as driving' },
    ],
  },
  {
    file: 'script-4.srt',
    title: 'Trading psychology',
    source: 'en',
    notes: 'Cue 12 ("Is that our brain…") is the tail of an answer whose question was cut.',
    checks: [
      { source: 'Completely different animals', mustNot: /حيوان/, why: 'idiom: "two different things"' },
      { source: 'it blows us up', mustNot: /[يت]فجر|ينفجر|انفجار/, why: 'trading slang for wiping out the account' },
      { source: 'competent trader', must: /متداول|تاجر/, why: 'trader in the markets sense' },
    ],
  },
  {
    file: 'script-5.srt',
    title: 'Comedy sketch: two colonial explorers',
    source: 'en',
    notes:
      'British comic register with innuendo. "filleted" (cue 25) is probably STT for "fêted"; ' +
      '"entire pair" probably "entire affair"; "menagatoire" and "papois" are mangled nonsense words.',
    checks: [
      { source: 'what you mean, old boy', mustNot: /الولد العجوز|الفتى العجوز|الصبي/, why: '"old boy" is a form of address' },
      { source: 'Whoops-a-daisy', mustNot: /أقحوان|زهرة/, why: 'an exclamation, not a flower' },
    ],
  },
  {
    file: 'script-6.srt',
    title: 'Stand-up roast',
    source: 'en',
    notes:
      'Cue 1 is probably STT for "Make fun of the robot voice". The doubled lines ("All right. / All right.") ' +
      'are real repetition, the comic hurrying through a joke he does not want to tell.',
    checks: [
      { source: "I've got it", mustNot: /لدي|عند[يه]|حصلت/, why: '"I\'ve got it" = "OK, I\'m on it", not possession' },
      { source: 'You a**hole', mustNot: /مجنون/, why: 'insult softened into "you madman"' },
      { source: 'kill me in my dreams', must: /حلم|أحلام|منام/, why: 'the Freddy Krueger setup needs "in my dreams"' },
    ],
  },
  {
    file: 'script-7.srt',
    title: 'Opera: Largo al factotum (Italian)',
    source: 'it',
    notes: 'Sung Italian, badly transcribed ("fototum" is "factotum", "malviere" is "barbiere"). Non-English source.',
    checks: [
      { source: 'Figaro, Figaro, Figaro', must: /فيغارو|فيجارو/, why: 'names are transliterated into Arabic letters' },
    ],
  },
  {
    file: 'script-8.srt',
    title: 'Comedy sketch: lightning in a bottle',
    source: 'en',
    notes:
      'The joke is that "lightning in a bottle" is meant as an idiom and taken literally, so the translation ' +
      'must keep the literal image every time it recurs. "honkers" refers back to the goose.',
    checks: [
      { source: 'catching lightning in a bottle', must: /برق/, why: 'the literal image carries the joke' },
      { source: 'I got actual lightning in a bottle', must: /برق/, why: 'the literal image carries the joke' },
      { source: 'goose that laid the golden egg', must: /[إأا]?وز/, why: '"honkers" in the next line refers to the goose' },
      { source: 'I got that, dog', mustNot: /كلب/, why: '"dog" is slang for "man"' },
    ],
  },
];
