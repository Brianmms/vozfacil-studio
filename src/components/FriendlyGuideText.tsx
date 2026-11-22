import React from 'react';

const VOWEL = /[aeiouáéíóúü]/i;

interface FriendlyGuideTextProps {
  text: string;
  className?: string;
}

/**
 * Keeps each word as a single unit (no gaps) and highlights the vowels with a
 * soft color. Vowel highlighting helps decoding without splitting words.
 */
export const FriendlyGuideText: React.FC<FriendlyGuideTextProps> = ({
  text,
  className = '',
}) => {
  const chars = Array.from(String(text || ''));
  return (
    <span className={className}>
      {chars.map((char, index) =>
        VOWEL.test(char) ? (
          <span key={index} className="font-extrabold text-sky-600">
            {char}
          </span>
        ) : (
          <React.Fragment key={index}>{char}</React.Fragment>
        )
      )}
    </span>
  );
};
