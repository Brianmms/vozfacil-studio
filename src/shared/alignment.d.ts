import type { WordEvaluation } from '../types';

export interface AlignmentResult {
  score: number;
  wordAccuracy: number;
  completeness: number;
  words: WordEvaluation[];
  extraWords: string[];
  expectedClean: string;
  transcribedClean: string;
}

export function stripStageDirections(text?: string): string;
export function normalizeWord(raw?: string): string;
export function levenshtein(a: string, b: string): number;
export function tokenSimilarity(normA: string, normB: string): number;
export function alignWords(
  expectedText: string,
  transcribedText: string,
  options?: { ignoreParentheses?: boolean }
): AlignmentResult;
