import React from 'react';

const SYLLABLE_COLORS = [
  'bg-sky-100 text-sky-950',
  'bg-indigo-100 text-indigo-950',
];

/**
 * Rough Spanish syllabifier: splits after a vowel when the next vowel is
 * separated by at least one consonant (keeps diphthongs like "ou"/"ei" together).
 * It is good enough for the phonetic guide (e.g. "medisin" -> me | di | sin).
 */
export function splitIntoSyllables(word: string): string[] {
  const clean = String(word || '').trim();
  if (!clean) return [];
  const marked = clean.replace(
    /([aeiouáéíóúü])(?=[^aeiouáéíóúü\s]+[aeiouáéíóúü])/gi,
    '$1|'
  );
  return marked.split('|').filter(Boolean);
}

interface SyllableChipsProps {
  text: string;
  className?: string;
}

export const SyllableChips: React.FC<SyllableChipsProps> = ({ text, className = '' }) => {
  const words = String(text || '')
    .split(/\s+/)
    .filter(Boolean);
  let syllableIndex = 0;

  return (
    <span className={`inline-flex flex-wrap items-baseline gap-x-2 gap-y-1.5 ${className}`}>
      {words.map((word, wordIdx) => {
        const syllables = splitIntoSyllables(word);
        return (
          <span key={`${word}-${wordIdx}`} className="inline-flex items-baseline gap-0.5">
            {syllables.map((syllable, idx) => {
              const color = SYLLABLE_COLORS[syllableIndex % SYLLABLE_COLORS.length];
              syllableIndex += 1;
              return (
                <span
                  key={`${syllable}-${idx}`}
                  className={`rounded-md px-1 font-bold ${color}`}
                >
                  {syllable}
                </span>
              );
            })}
          </span>
        );
      })}
    </span>
  );
};
