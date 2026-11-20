export type VoiceId = 'stella' | 'tide';

export interface WordGuide {
  word: string;
  phoneticEs: string;
  meaningEs: string;
  tipEs?: string;
}

export interface WordEvaluation {
  expected: string;
  heard: string | null;
  status: 'correct' | 'close' | 'incorrect' | 'missing';
  similarity: number;
}

export interface WordFeedbackItem {
  word: string;
  heard: string;
  phoneticEs: string;
  tipEs: string;
}

export interface EvaluationResult {
  id: string;
  createdAt: string;
  expectedText: string;
  transcribedText: string;
  durationMs: number;
  score: number;
  alignmentScore: number;
  wordAccuracy: number;
  completeness: number;
  words: WordEvaluation[];
  extraWords: string[];
  encouragingTitle: string;
  summary: string;
  wordFeedback: WordFeedbackItem[];
  nextStepTip: string;
}

export interface Take {
  id: string;
  createdAt: string;
  label: string;
  filename: string;
  audioUrl: string;
  durationSec: number;
  peaks: number[];
  evaluation?: EvaluationResult;
}

export interface ScriptSegment {
  id: string;
  order: number;
  title: string;
  speaker?: string;
  speakerPhoneticEs?: string;
  text: string;
  cueBefore?: string;
  cueAfter?: string;
  pauseAfterSec: number;
  phoneticEs: string;
  translationEs: string;
  tipsEs: string[];
  words: WordGuide[];
  takes: Take[];
  selectedTakeId: string | null;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  segments: ScriptSegment[];
}

export interface AudioCutRange {
  start: number;
  end: number;
}

export interface StudioClip {
  id: string;
  sourceSegmentId?: string;
  title: string;
  text?: string;
  speaker?: string;
  cueAfter?: string;
  audioUrl: string;
  filename?: string;
  durationSec: number;
  trimStart: number;
  trimEnd: number;
  cuts?: AudioCutRange[];
  pauseAfterSec: number;
  gain: number;
  peaks: number[];
}

export interface TimelineOffset {
  clipId: string;
  title: string;
  startSec: number;
  endSec: number;
}

export interface StitchedRender {
  audioBuffer: AudioBuffer;
  wavBlob: Blob;
  durationSec: number;
  peaks: number[];
  timelineOffsets: TimelineOffset[];
}

export interface HealthStatus {
  ok: boolean;
  hasApiKey: boolean;
  model: string;
  baseUrl: string;
  ffmpegInstalled: boolean;
  audioEngine: string;
}

export interface WordExplanation {
  word: string;
  phoneticEs: string;
  syllablesEs?: string;
  meaningEs: string;
  tipEs: string;
  fromAI?: boolean;
}
