/**
 * Arabic subtitle conventions, from the Netflix Arabic Timed Text Style Guide
 * (partnerhelp.netflixstudios.com, article 215517947).
 *
 * Two halves. `ARABIC_RULES` is what only the translator can get right —
 * register, names, profanity — and goes into the chat prompt. `tidyArabic` is
 * what code can enforce on any translator's output, `m2m100` and Riva
 * included: punctuation and month names.
 */

/** Appended to the chat translator's system prompt when the target is Arabic. */
export const ARABIC_RULES = [
  'Write Modern Standard Arabic only: no dialect words or dialect expressions.',
  'Names of people are transliterated into Arabic letters (Bob Osteen → بوب أوستين); places and ' +
    'currencies use their Arabic names (المكسيك، اليورو).',
  'No Latin letters at all. An acronym takes its known Arabic equivalent (CIA → وكالة الاستخبارات ' +
    'المركزية), or is transliterated as spoken (UNICEF → يونيسف); a website or brand is written ' +
    'in Arabic letters.',
  'Swearing and insults are rendered as faithfully as possible, at the same strength, with an ' +
    'equivalent Modern Standard Arabic insult (أيها الوغد، أيها الحقير): never soften one into a ' +
    'milder word, and never add obscenity the original does not have.',
  'Leave out fillers ("you know", "basically", "I mean") and bare interjections ("wow", "ouch") ' +
    'unless they add meaning.',
  'Numbers from one to ten are written in words with correct agreement (العدد والمعدود); above ten, ' +
    'in digits. Months use the Gregorian names (أغسطس, not آب).',
  'End the line with the punctuation it needs. Never combine ? and !.',
].join(' ');

/** Levantine and Iraqi month names, longest first so تشرين الأول is not read as تشرين. */
const MONTHS: [string, string][] = [
  ['كانون الثاني', 'يناير'],
  ['تشرين الأول', 'أكتوبر'],
  ['تشرين الثاني', 'نوفمبر'],
  ['كانون الأول', 'ديسمبر'],
  ['شباط', 'فبراير'],
  ['آذار', 'مارس'],
  ['نيسان', 'أبريل'],
  ['أيار', 'مايو'],
  ['حزيران', 'يونيو'],
  ['تموز', 'يوليو'],
  ['أيلول', 'سبتمبر'],
];

/**
 * A whole Arabic word, allowing the one-letter prefixes written joined to it
 * (وشباط، في آذار، بنيسان) but not a longer word that merely contains it.
 */
const word = (w: string): RegExp =>
  new RegExp(`(?<=(?:^|[^\\p{Script=Arabic}])[وفبل]?)${w}(?![\\p{Script=Arabic}])`, 'gu');

/**
 * Punctuation and month names in a translated Arabic line, as the guide sets
 * them. `آب` (August) is left alone: it is also a word, and a wrong
 * replacement is worse than a regional month name.
 */
export function tidyArabic(text: string): string {
  let out = text
    // One ellipsis character, never three dots.
    .replace(/\.{3,}|\.\s\.\s\./g, '…')
    // Pick one of ?! — the question is what a subtitle reader needs to see.
    .replace(/[?؟]\s*!+|!+\s*[?؟]/g, '؟')
    // No space before a comma, stop, question or exclamation mark.
    .replace(/\s+([،,.؛;:؟?!…])/g, '$1');
  for (const [from, to] of MONTHS) out = out.replace(word(from), to);
  return out;
}
