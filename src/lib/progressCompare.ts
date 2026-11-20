import type { EvaluationResult, WordEvaluation } from '../types';

export interface EvaluationComparison {
  previousScore: number;
  currentScore: number;
  delta: number;
  previousBestScore: number;
  isNewBest: boolean;
  previousLabel: string;
  improvedWords: string[];
  regressedWords: string[];
  stillNeedsWork: string[];
}

const STATUS_RANK: Record<WordEvaluation['status'], number> = {
  missing: 0,
  incorrect: 1,
  close: 2,
  correct: 3,
};

function normWord(raw: string): string {
  return raw
    .replace(/[’‘`]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
}

function cleanDisplayWord(raw: string): string {
  return raw.replace(/^["'“”‘’(\[]+|["'“”‘’).!?,;:]+$/g, '') || raw;
}

export function normalizeCompareText(text: string): string {
  return String(text || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[’‘`]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compareEvaluations(
  current: EvaluationResult,
  previous: EvaluationResult,
  options: {
    previousBestScore?: number;
    previousLabel?: string;
  } = {}
): EvaluationComparison {
  const previousScore = Math.round(previous.score);
  const currentScore = Math.round(current.score);
  const delta = currentScore - previousScore;
  const previousBestScore = Math.max(
    previousScore,
    Math.round(options.previousBestScore ?? previousScore)
  );
  const isNewBest = currentScore > previousBestScore;
  const previousLabel = options.previousLabel || 'el intento anterior';

  const prevWords = previous.words || [];
  const currWords = current.words || [];

  // Build map of available previous indices by normalized word
  const usedPrev = new Set<number>();
  const prevByNorm = new Map<string, number[]>();
  prevWords.forEach((w, idx) => {
    const key = normWord(w.expected);
    if (!key) return;
    const list = prevByNorm.get(key) || [];
    list.push(idx);
    prevByNorm.set(key, list);
  });

  const improvedWords: string[] = [];
  const regressedWords: string[] = [];
  const stillNeedsWork: string[] = [];

  const seenImproved = new Set<string>();
  const seenRegressed = new Set<string>();
  const seenStill = new Set<string>();

  currWords.forEach((cw, idx) => {
    const key = normWord(cw.expected);
    if (!key) return;
    const label = cleanDisplayWord(cw.expected);

    // Try exact positional match first
    let matchedPrevIdx: number | undefined;
    if (
      idx < prevWords.length &&
      !usedPrev.has(idx) &&
      normWord(prevWords[idx].expected) === key
    ) {
      matchedPrevIdx = idx;
    } else {
      const candidates = prevByNorm.get(key) || [];
      matchedPrevIdx = candidates.find((cIdx) => !usedPrev.has(cIdx));
    }

    const currRank = STATUS_RANK[cw.status];

    if (matchedPrevIdx === undefined) {
      if (currRank < 3 && !seenStill.has(key) && stillNeedsWork.length < 6) {
        seenStill.add(key);
        stillNeedsWork.push(label);
      }
      return;
    }

    usedPrev.add(matchedPrevIdx);
    const prevRank = STATUS_RANK[prevWords[matchedPrevIdx].status];

    if (currRank > prevRank && (currRank === 3 || (prevRank <= 1 && currRank === 2))) {
      if (!seenImproved.has(key)) {
        seenImproved.add(key);
        improvedWords.push(label);
      }
    } else if (prevRank === 3 && currRank < 3) {
      if (!seenRegressed.has(key)) {
        seenRegressed.add(key);
        regressedWords.push(label);
      }
    } else if (currRank < 3 && prevRank < 3) {
      if (!seenStill.has(key) && stillNeedsWork.length < 6) {
        seenStill.add(key);
        stillNeedsWork.push(label);
      }
    }
  });

  return {
    previousScore,
    currentScore,
    delta,
    previousBestScore,
    isNewBest,
    previousLabel,
    improvedWords,
    regressedWords,
    stillNeedsWork,
  };
}
