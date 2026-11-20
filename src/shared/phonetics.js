const PROPER_NAMES = new Set(['sofía', 'sofías', 'tomás', 'julián', 'ruiz']);

/**
 * Normalizes Spanish phonetic guides so they read smoothly without hyphenated
 * syllable breaks (e.g. "so-FÍ-as" -> "Sofías", "BÉRT-dei" -> "bértdei")
 * or jarring mid-word uppercase chunks that cause beginners to pause.
 */
export function cleanSpanishPhonetic(text = '') {
  let out = String(text || '').trim();
  if (!out) return '';

  // Repeatedly merge letter-hyphen-letter patterns (including spaced hyphens)
  const hyphenPattern = /([A-Za-zÁÉÍÓÚáéíóúÑñÜü])\s*[-–—]\s*([A-Za-zÁÉÍÓÚáéíóúÑñÜü])/g;
  let prev = '';
  while (out !== prev) {
    prev = out;
    out = out.replace(hyphenPattern, '$1$2');
  }

  // Normalize jarring mid-word uppercase chunks while keeping clean proper names
  out = out.replace(/[A-Za-zÁÉÍÓÚáéíóúÑñÜü]+/g, (word) => {
    const lower = word.toLowerCase();
    if (PROPER_NAMES.has(lower)) {
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }

    // Preserve words that already have at most a single leading uppercase letter
    const hasOnlyLeadingCap =
      word.length > 1 &&
      word[0] !== word[0].toLowerCase() &&
      word.slice(1) === word.slice(1).toLowerCase();
    if (hasOnlyLeadingCap) {
      return word;
    }

    return lower;
  });

  return out.replace(/\s+/g, ' ').trim();
}
