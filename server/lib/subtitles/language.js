/**
 * Work out what language a subtitle track is actually in, by reading it.
 *
 * The filename is not trustworthy. A real file here is named "...en-es-419.srt"
 * and contains no English at all — the tag describes the release bundle, not
 * the contents. Labelling tracks from the filename produced a language menu
 * where every entry claimed to be English, which makes the menu useless.
 *
 * Script comes first, because a writing system is a fact rather than a guess.
 * Latin-script languages are then separated on function words, which are short,
 * extremely common, and largely disjoint between languages.
 */

const SCRIPTS = [
  [/[぀-ゟ゠-ヿ]/g, 'jpn'], // kana — decisive for Japanese
  [/[가-힯]/g, 'kor'],              // hangul
  [/[Ѐ-ӿ]/g, 'rus'],
  [/[֐-׿]/g, 'heb'],
  [/[؀-ۿ]/g, 'ara'],
  [/[฀-๿]/g, 'tha'],
  [/[Ͱ-Ͽ]/g, 'ell'],
];

// Han characters alone can't separate Chinese from Japanese, so they are only
// consulted when no kana are present.
const HAN = /[一-鿿]/g;

const STOPWORDS = {
  eng: ['the', 'you', 'and', 'is', 'it', 'that', 'this', 'to', 'of', 'in', 'for', 'with', 'have', 'what', 'there', 'was', 'are', 'not', 'but', 'they'],
  spa: ['que', 'de', 'la', 'el', 'los', 'las', 'una', 'con', 'para', 'por', 'pero', 'esto', 'esta', 'como', 'muy', 'se', 'te', 'del', 'está', 'porque'],
  por: ['que', 'não', 'uma', 'para', 'com', 'mais', 'isso', 'você', 'está', 'como', 'mas', 'por', 'das', 'dos', 'ele', 'ela', 'meu', 'muito', 'então', 'aqui'],
  fra: ['que', 'les', 'des', 'est', 'pas', 'pour', 'vous', 'dans', 'une', 'qui', 'mais', 'avec', 'tout', 'sur', 'plus', 'moi', 'ce', 'je', 'nous', 'elle'],
  ita: ['che', 'non', 'per', 'una', 'con', 'sono', 'questo', 'come', 'più', 'ma', 'mi', 'ti', 'della', 'dei', 'anche', 'quando', 'cosa', 'bene', 'lui', 'lei'],
  deu: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'sie', 'mit', 'ein', 'eine', 'auf', 'für', 'aber', 'was', 'wir', 'den', 'dem', 'noch', 'auch'],
  nld: ['de', 'het', 'een', 'niet', 'dat', 'ik', 'je', 'van', 'en', 'is', 'op', 'te', 'zijn', 'maar', 'wat', 'met', 'voor', 'als', 'heb', 'hij'],
  pol: ['nie', 'się', 'jest', 'że', 'to', 'na', 'do', 'jak', 'ale', 'tak', 'co', 'za', 'tym', 'jego', 'przez', 'tylko', 'już', 'może', 'być', 'ma'],
};

const WORD_RE = /[\p{L}\p{M}']+/gu;

/**
 * @param {Array<{text:string}>} cues
 * @returns {{lang: string|null, confidence: number, method: string}}
 */
export function detectLanguage(cues) {
  const sample = cues
    .slice(0, 600)
    .map((c) => c.text.replace(/<[^>]*>/g, ' '))
    .join(' ');

  if (sample.trim().length < 40) return { lang: null, confidence: 0, method: 'too-short' };

  // --- script ---
  const letters = (sample.match(/\p{L}/gu) || []).length || 1;
  for (const [re, lang] of SCRIPTS) {
    const hits = (sample.match(re) || []).length;
    if (hits / letters > 0.08) return { lang, confidence: Math.min(1, hits / letters * 4), method: 'script' };
  }
  const han = (sample.match(HAN) || []).length;
  if (han / letters > 0.15) return { lang: 'zho', confidence: Math.min(1, (han / letters) * 3), method: 'script' };

  // --- function words ---
  const words = (sample.toLowerCase().match(WORD_RE) || []);
  if (words.length < 30) return { lang: null, confidence: 0, method: 'too-few-words' };

  const counts = new Map(words.map((w) => [w, 0]));
  for (const w of words) counts.set(w, counts.get(w) + 1);

  const scores = Object.entries(STOPWORDS)
    .map(([lang, list]) => [lang, list.reduce((n, w) => n + (counts.get(w) || 0), 0) / words.length])
    .sort((a, b) => b[1] - a[1]);

  const [best, bestScore] = scores[0];
  const runnerUp = scores[1][1];
  if (bestScore < 0.02) return { lang: null, confidence: 0, method: 'inconclusive' };

  // Spanish, Portuguese and Italian share function words, so a win is only
  // trusted when it clears the runner-up by a real margin.
  const margin = runnerUp > 0 ? bestScore / runnerUp : 4;
  return {
    lang: best,
    confidence: Math.min(1, (bestScore * 6) * Math.min(1, margin / 2)),
    method: 'stopwords',
  };
}
