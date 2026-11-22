export interface NumberGuide {
  word: string;
  phoneticEs: string;
  meaningEs: string;
  tipEs: string;
}

const ONES_WORD = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const ONES_PHONETIC = [
  'zírou', 'uán', 'tú', 'zrí', 'fór', 'fáiv', 'síks', 'séven', 'éit', 'náin',
  'tén', 'iléven', 'tuélv', 'zertín', 'fortín', 'fiftín', 'sikstín',
  'seventín', 'éitin', 'náintín',
];
const TENS_WORD = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const TENS_PHONETIC = ['', '', 'tuénti', 'zérti', 'fórti', 'fífti', 'síksti', 'séventi', 'éiti', 'náinti'];

const NUMBER_WORD_PHONETIC = new Map<string, string>();
ONES_WORD.forEach((word, index) => NUMBER_WORD_PHONETIC.set(word, ONES_PHONETIC[index]));
TENS_WORD.forEach((word, index) => {
  if (word) NUMBER_WORD_PHONETIC.set(word, TENS_PHONETIC[index]);
});

export function numberGuide(raw: string): NumberGuide | null {
  const match = String(raw || '').match(/\d{1,3}/);
  if (!match) return null;
  const value = Number(match[0]);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;

  let word = '';
  let phonetic = '';
  if (value <= 19) {
    word = ONES_WORD[value];
    phonetic = ONES_PHONETIC[value];
  } else if (value === 100) {
    word = 'one hundred';
    phonetic = 'uán jóndred';
  } else {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    word = TENS_WORD[tens] + (ones ? `-${ONES_WORD[ones]}` : '');
    phonetic = TENS_PHONETIC[tens] + (ones ? `-${ONES_PHONETIC[ones]}` : '');
  }

  return {
    word,
    phoneticEs: phonetic,
    meaningEs: String(value),
    tipEs:
      value === 15
        ? 'fifteen se dice "fiftín": el golpe fuerte va al final (fif-TÍN).'
        : `Se dice "${word}" (${phonetic}).`,
  };
}

/** Replaces digits or written English numbers inside a phonetic guide. */
export function replaceNumbersInPhonetic(text: string): string {
  let out = String(text || '');
  out = out.replace(/\b\d{1,3}\b/g, (match) => numberGuide(match)?.phoneticEs || match);
  out = out.replace(/\b[a-z]+\b/gi, (match) => {
    const key = match.toLowerCase();
    return NUMBER_WORD_PHONETIC.get(key) || match;
  });
  return out;
}
