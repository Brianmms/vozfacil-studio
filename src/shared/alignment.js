const NUMBER_WORDS = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  first: '1st',
  second: '2nd',
  third: '3rd',
  fourth: '4th',
  fifth: '5th',
  eleventh: '11th',
};

const CANONICAL_EQUIVALENTS = {
  mrs: 'mrs',
  missus: 'mrs',
  misses: 'mrs',
  missis: 'mrs',
  mr: 'mr',
  mister: 'mr',
  cannot: 'cant',
  "can't": 'cant',
  cant: 'cant',
  "wouldn't": 'wouldnt',
  wouldnt: 'wouldnt',
  "it's": 'its',
  its: 'its',
  "sofia's": 'sofias',
  sofias: 'sofias',
  "sophia's": 'sofias',
  sophias: 'sofias',
  sofia: 'sofia',
  sophia: 'sofia',
  tomas: 'tomas',
  thomas: 'tomas',
};

// Homophone sets so valid ASR phonetic transcriptions aren't unfairly penalized
const HOMOPHONE_GROUPS = [
  ['4', 'for'],
  ['2', 'to', 'too'],
  ['1', 'won'],
  ['red', 'read'],
  ['would', 'wood'],
  ['hi', 'high'],
  ['so', 'sew'],
  ['dear', 'deer'],
  ['be', 'bee'],
  ['know', 'no'],
  ['right', 'write'],
  ['their', 'there'],
  ['new', 'knew'],
  ['in', 'inn'],
  ['at', 'ad'],
];

const HOMOPHONE_KEY = new Map();
HOMOPHONE_GROUPS.forEach((group, idx) => {
  for (const item of group) {
    HOMOPHONE_KEY.set(item, `H${idx}`);
  }
});

export function stripStageDirections(text = '') {
  return String(text)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeWord(raw = '') {
  const cleaned = String(raw)
    .replace(/[’‘`]/g, "'")
    .replace(/[“”"]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');

  if (!cleaned) return '';

  const withoutApos = cleaned.replace(/'/g, '');
  if (CANONICAL_EQUIVALENTS[cleaned]) return CANONICAL_EQUIVALENTS[cleaned];
  if (CANONICAL_EQUIVALENTS[withoutApos]) return CANONICAL_EQUIVALENTS[withoutApos];
  if (NUMBER_WORDS[withoutApos]) return NUMBER_WORDS[withoutApos];
  return withoutApos;
}

function tokenizeDisplay(text = '') {
  // Split on whitespace and hyphens, keeping display punctuation attached where natural,
  // and split attached "3pm" -> ["3", "pm"] if encountered
  const rawTokens = String(text)
    .replace(/([a-zA-Z0-9])[-–—]([a-zA-Z0-9])/g, '$1 $2')
    .replace(/(\d+)(am|pm)\b/gi, '$1 $2')
    .replace(/\bp\.?\s*m\.?\b/gi, 'PM')
    .replace(/\ba\.?\s*m\.?\b/gi, 'AM')
    .split(/\s+/)
    .filter(Boolean);

  const tokens = [];
  for (const raw of rawTokens) {
    const norm = normalizeWord(raw);
    if (!norm) continue;
    tokens.push({ display: raw, norm });
  }
  return tokens;
}

function mergeSpokenPairs(transTokens, expectedNormsSet) {
  const merged = [];
  for (let i = 0; i < transTokens.length; i++) {
    const curr = transTokens[i];
    const next = transTokens[i + 1];

    if (next) {
      const pair = `${curr.norm} ${next.norm}`;
      if (pair === 'p m') {
        merged.push({ display: `${curr.display} ${next.display}`, norm: 'pm' });
        i++;
        continue;
      }
      if (pair === 'a m') {
        merged.push({ display: `${curr.display} ${next.display}`, norm: 'am' });
        i++;
        continue;
      }
      if (pair === 'can not') {
        merged.push({ display: `${curr.display} ${next.display}`, norm: 'cant' });
        i++;
        continue;
      }
      if (pair === 'would not') {
        merged.push({ display: `${curr.display} ${next.display}`, norm: 'wouldnt' });
        i++;
        continue;
      }
      if (pair === 'it is' && expectedNormsSet.has('its')) {
        merged.push({ display: `${curr.display} ${next.display}`, norm: 'its' });
        i++;
        continue;
      }
      if (pair === 'want to' && expectedNormsSet.has('wanna')) {
        merged.push({ display: `${curr.display} ${next.display}`, norm: 'wanna' });
        i++;
        continue;
      }
    }

    merged.push(curr);
  }
  return merged;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

export function tokenSimilarity(normA, normB) {
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const homA = HOMOPHONE_KEY.get(normA);
  const homB = HOMOPHONE_KEY.get(normB);
  if (homA && homB && homA === homB) return 1;

  const dist = levenshtein(normA, normB);
  const maxLen = Math.max(normA.length, normB.length);
  return maxLen === 0 ? 1 : Math.max(0, 1 - dist / maxLen);
}

export function alignWords(expectedText, transcribedText, options = {}) {
  const { ignoreParentheses = true } = options;

  const expectedClean = ignoreParentheses
    ? stripStageDirections(expectedText)
    : String(expectedText || '').trim();
  const transcribedClean = String(transcribedText || '').trim();

  const expectedTokens = tokenizeDisplay(expectedClean);
  const expectedNormsSet = new Set(expectedTokens.map((t) => t.norm));

  const rawTransTokens = tokenizeDisplay(transcribedClean);
  const transTokens = mergeSpokenPairs(rawTransTokens, expectedNormsSet);

  const m = expectedTokens.length;
  const n = transTokens.length;

  if (m === 0) {
    return {
      score: 0,
      wordAccuracy: 0,
      completeness: 0,
      words: [],
      extraWords: transTokens.map((t) => t.display),
      expectedClean,
      transcribedClean,
    };
  }

  // Needleman-Wunsch dynamic programming alignment
  const GAP_PENALTY = -1.5;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  const simMatrix = Array.from({ length: m }, () => new Array(n).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i * GAP_PENALTY;
  for (let j = 0; j <= n; j++) dp[0][j] = j * GAP_PENALTY;

  function matchWeight(sim) {
    if (sim === 1) return 3.0;
    if (sim >= 0.62) return 1.5;
    return -1.0;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sim = tokenSimilarity(expectedTokens[i - 1].norm, transTokens[j - 1].norm);
      simMatrix[i - 1][j - 1] = sim;

      const diag = dp[i - 1][j - 1] + matchWeight(sim);
      const up = dp[i - 1][j] + GAP_PENALTY;
      const left = dp[i][j - 1] + GAP_PENALTY;

      dp[i][j] = Math.max(diag, up, left);
    }
  }

  // Backtrack
  const alignedWords = [];
  const extraWords = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const sim = simMatrix[i - 1][j - 1];
      const diagScore = dp[i - 1][j - 1] + matchWeight(sim);
      if (Math.abs(dp[i][j] - diagScore) < 1e-9) {
        let status = 'incorrect';
        if (sim === 1) status = 'correct';
        else if (sim >= 0.62) status = 'close';

        alignedWords.push({
          expected: expectedTokens[i - 1].display,
          heard: transTokens[j - 1].display,
          status,
          similarity: Number(sim.toFixed(2)),
        });
        i--;
        j--;
        continue;
      }
    }

    if (i > 0 && Math.abs(dp[i][j] - (dp[i - 1][j] + GAP_PENALTY)) < 1e-9) {
      alignedWords.push({
        expected: expectedTokens[i - 1].display,
        heard: null,
        status: 'missing',
        similarity: 0,
      });
      i--;
    } else {
      extraWords.push(transTokens[j - 1].display);
      j--;
    }
  }

  alignedWords.reverse();
  extraWords.reverse();

  let points = 0;
  let spoken = 0;
  for (const w of alignedWords) {
    if (w.status === 'correct') {
      points += 1.0;
      spoken += 1;
    } else if (w.status === 'close') {
      points += 0.65;
      spoken += 1;
    } else if (w.status === 'incorrect') {
      points += 0.1;
      spoken += 1;
    }
  }

  const wordAccuracy = Math.round((points / m) * 100);
  const completeness = Math.round((spoken / m) * 100);
  const extraPenalty = Math.min(10, Math.max(0, extraWords.length - 2) * 2);
  const score = Math.max(
    0,
    Math.min(100, Math.round(wordAccuracy * 0.8 + completeness * 0.2 - extraPenalty))
  );

  return {
    score,
    wordAccuracy,
    completeness,
    words: alignedWords,
    extraWords,
    expectedClean,
    transcribedClean,
  };
}
