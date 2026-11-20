import type {
  EvaluationResult,
  HealthStatus,
  Project,
  VoiceId,
  WordExplanation,
} from '../types';
import {
  deleteAudioBlob,
  deleteEvaluation,
  deleteProject,
  getEvaluations,
  getProjects,
  resetSeedProject,
  saveAudioBlob,
  saveProject,
} from './localStore';
import {
  evaluateAudioClient,
  explainWordClient,
  prepareScriptClient,
  synthesizeSpeechClient,
} from './deepseekClient';
import { getDeepSeekSettings } from './settings';

export async function fetchHealth(): Promise<HealthStatus> {
  const cfg = getDeepSeekSettings();
  return {
    ok: true,
    hasApiKey: Boolean(cfg.apiKey),
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    ffmpegInstalled: false,
    audioEngine: '100% navegador (Web Audio + IndexedDB)',
  };
}

export async function fetchProjects(): Promise<Project[]> {
  return getProjects();
}

export async function saveProjectApi(project: Project): Promise<Project> {
  return saveProject(project);
}

export async function createProjectApi(project: Project): Promise<Project> {
  return saveProject(project);
}

export async function deleteProjectApi(id: string): Promise<void> {
  await deleteProject(id);
}

export async function resetProjectApi(id: string): Promise<Project> {
  return resetSeedProject(id);
}

export async function prepareScriptApi(params: {
  title: string;
  rawText: string;
  save?: boolean;
}): Promise<{ project: Project; usedAI: boolean }> {
  return prepareScriptClient(params);
}

export async function explainWordApi(
  word: string,
  context?: string
): Promise<WordExplanation> {
  return explainWordClient({ word, context });
}

export async function requestTtsAudio(text: string, voiceId: VoiceId): Promise<Blob> {
  return synthesizeSpeechClient({ text, voiceId });
}

export async function uploadAudioBlob(
  wavBlob: Blob,
  filename = 'recording.wav'
): Promise<{ filename: string; url: string; sizeBytes: number }> {
  return saveAudioBlob(wavBlob, filename);
}

export async function deleteAudioApi(filename: string): Promise<void> {
  await deleteAudioBlob(filename);
}

export async function evaluateAudioApi(params: {
  wavChunks: Blob[];
  expectedText: string;
  ignoreParentheses?: boolean;
  saveHistory?: boolean;
}): Promise<EvaluationResult> {
  return evaluateAudioClient(params);
}

export async function fetchEvaluations(): Promise<EvaluationResult[]> {
  return getEvaluations();
}

export async function deleteEvaluationApi(id: string): Promise<void> {
  await deleteEvaluation(id);
}
