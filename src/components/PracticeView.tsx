import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  HelpCircle,
  Loader2,
  Mic,
  Pause,
  Play,
  Plus,
  Repeat,
  RotateCcw,
  Sparkles,
  Square,
  Star,
  Trash2,
  TrendingUp,
  Trophy,
  Upload,
  Volume2,
  Wand2,
} from 'lucide-react';
import type {
  Project,
  ScriptSegment,
  Take,
  VoiceId,
  WordGuide,
} from '../types';
import {
  deleteAudioApi,
  deleteProjectApi,
  evaluateAudioApi,
  resetProjectApi,
  uploadAudioBlob,
} from '../lib/api';
import { PcmAudioRecorder } from '../lib/audioRecorder';
import {
  convertBlobToCleanWav,
  convertToAsrWavChunks,
  ensureAudioContextRunning,
  evictAudioBufferCache,
  fetchAudioBuffer,
  formatTime,
} from '../lib/audioUtils';
import {
  playWordByWord,
  speakEnglishText,
  stopAllSpeech,
} from '../lib/ttsPlayer';
import { compareEvaluations, type EvaluationComparison } from '../lib/progressCompare';
import { loadAudioBlobFromUrl } from '../lib/localStore';
import { EvaluationCard } from './EvaluationCard';
import { NewScriptModal } from './NewScriptModal';
import { WaveformCanvas } from './WaveformCanvas';
import { WordPopover } from './WordPopover';

interface PracticeViewProps {
  projects: Project[];
  activeProjectId: string;
  voiceId: VoiceId;
  hasApiKey: boolean;
  onSelectProject: (id: string) => void;
  onUpdateProject: (updated: Project) => Promise<void>;
  onAddProject: (project: Project) => void;
  onRemoveProject: (id: string) => void;
  onGoToStudio: () => void;
  onOpenSettings?: () => void;
}

const SPEED_OPTIONS = [
  { rate: 0.6, label: '0.6x Muy lento' },
  { rate: 0.75, label: '0.75x Lento' },
  { rate: 0.9, label: '0.9x Pausado' },
  { rate: 1.0, label: '1.0x Normal' },
];

function cleanWordKey(token: string): string {
  return token
    .replace(/[’‘`]/g, "'")
    .replace(/^[^a-zA-Z0-9'’]+|[^a-zA-Z0-9'’]+$/g, '')
    .toLowerCase();
}

export const PracticeView: React.FC<PracticeViewProps> = ({
  projects,
  activeProjectId,
  voiceId,
  hasApiKey,
  onSelectProject,
  onUpdateProject,
  onAddProject,
  onRemoveProject,
  onGoToStudio,
  onOpenSettings,
}) => {
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) || projects[0],
    [projects, activeProjectId]
  );

  const [activeSegmentIdx, setActiveSegmentIdx] = useState(0);
  const [focusSpeaker, setFocusSpeaker] = useState<string | null>(null);
  const [speedRate, setSpeedRate] = useState(0.85);
  const [showSpanishHelp, setShowSpanishHelp] = useState(true);
  const [easyReadMode, setEasyReadMode] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [isPlayingGuide, setIsPlayingGuide] = useState(false);
  const [isWordMode, setIsWordMode] = useState(false);
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState(false);

  // Word modal
  const [selectedWord, setSelectedWord] = useState<{
    token: string;
    guide?: WordGuide;
  } | null>(null);

  // Recording state
  const [useCountdown, setUseCountdown] = useState(true);
  const [autoEvaluate, setAutoEvaluate] = useState(true);
  const [countdownNum, setCountdownNum] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [recElapsed, setRecElapsed] = useState(0);
  const [savingTake, setSavingTake] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  // Take playback & evaluation
  const [playingTakeId, setPlayingTakeId] = useState<string | null>(null);
  const [takePlayhead, setTakePlayhead] = useState<{
    takeId: string;
    sec: number;
  } | null>(null);
  const [evaluatingTakeId, setEvaluatingTakeId] = useState<string | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);

  // Modals / manual segment add
  const [showNewModal, setShowNewModal] = useState(false);
  const [addingManualPart, setAddingManualPart] = useState(false);
  const [manualPartText, setManualPartText] = useState('');

  const recorderRef = useRef<PcmAudioRecorder | null>(null);
  const speechAbortRef = useRef<AbortController | null>(null);
  const loopActiveRef = useRef(false);
  const takeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const takeRafRef = useRef<number | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setActiveSegmentIdx(0);
    setFocusSpeaker(null);
    stopSpeaking();
    stopTakeAudio();
  }, [activeProject?.id]);

  useEffect(() => {
    stopSpeaking();
    stopTakeAudio();
    setEvalError(null);
    setRecError(null);
  }, [activeSegmentIdx]);

  useEffect(() => {
    return () => {
      stopSpeaking();
      stopTakeAudio();
      recorderRef.current?.cancel();
    };
  }, []);

  if (!activeProject) {
    return null;
  }

  const segments = activeProject.segments;
  const safeIdx = Math.min(activeSegmentIdx, Math.max(0, segments.length - 1));
  const segment: ScriptSegment | undefined = segments[safeIdx];

  const speakers = Array.from(
    new Set(segments.map((s) => s.speaker).filter(Boolean))
  ) as string[];
  const matchesFocus = (seg: ScriptSegment) =>
    !focusSpeaker || !seg.speaker || seg.speaker === focusSpeaker;

  const readyCount = segments.filter((s) => Boolean(s.selectedTakeId)).length;
  const tokens = useMemo(
    () => (segment ? segment.text.split(/\s+/).filter(Boolean) : []),
    [segment?.text]
  );

  function stopSpeaking() {
    loopActiveRef.current = false;
    setIsLooping(false);
    speechAbortRef.current?.abort();
    speechAbortRef.current = null;
    stopAllSpeech();
    setIsPlayingGuide(false);
    setIsWordMode(false);
    setActiveWordIndex(null);
  }

  function stopTakeAudio(resetPlayhead = true) {
    if (takeRafRef.current !== null) {
      cancelAnimationFrame(takeRafRef.current);
      takeRafRef.current = null;
    }
    if (takeSourceRef.current) {
      const oldSource = takeSourceRef.current;
      takeSourceRef.current = null;
      try {
        oldSource.stop();
        oldSource.disconnect();
      } catch {
        // Ignore already-stopped source
      }
    }
    setPlayingTakeId(null);
    if (resetPlayhead) {
      setTakePlayhead(null);
    }
  }

  async function handlePlayPhrase(loop = false) {
    if (!segment) return;
    if (isPlayingGuide) {
      stopSpeaking();
      return;
    }

    stopTakeAudio();
    const controller = new AbortController();
    speechAbortRef.current = controller;
    loopActiveRef.current = loop;
    setIsLooping(loop);
    setIsPlayingGuide(true);

    try {
      do {
        const res = await speakEnglishText(segment.text, {
          voiceId,
          rate: speedRate,
          signal: controller.signal,
        });
        if (res.usedFallback) setFallbackNotice(true);
        if (!loopActiveRef.current || controller.signal.aborted) break;
        await new Promise((r) => setTimeout(r, 700));
      } while (loopActiveRef.current && !controller.signal.aborted);
    } finally {
      if (speechAbortRef.current === controller) {
        setIsPlayingGuide(false);
        setIsLooping(false);
        loopActiveRef.current = false;
      }
    }
  }

  async function handleWordByWord() {
    if (!segment) return;
    if (isWordMode) {
      stopSpeaking();
      return;
    }

    stopTakeAudio();
    const controller = new AbortController();
    speechAbortRef.current = controller;
    setIsWordMode(true);

    try {
      const res = await playWordByWord(tokens, {
        voiceId,
        rate: Math.min(0.9, speedRate),
        pauseMs: 320,
        onWordIndex: setActiveWordIndex,
        signal: controller.signal,
      });
      if (res.usedFallback) setFallbackNotice(true);
    } finally {
      if (speechAbortRef.current === controller) {
        setIsWordMode(false);
        setActiveWordIndex(null);
      }
    }
  }

  function findWordGuide(token: string): WordGuide | undefined {
    if (!segment?.words?.length) return undefined;
    const key = cleanWordKey(token);
    return segment.words.find((w) => cleanWordKey(w.word) === key);
  }

  function handleWordClick(token: string) {
    stopSpeaking();
    const spoken = token.replace(/^[^a-zA-Z0-9'’]+|[^a-zA-Z0-9'’]+$/g, '');
    if (spoken) {
      speakEnglishText(spoken, { voiceId, rate: Math.min(0.9, speedRate) })
        .then((res) => {
          if (res.usedFallback) setFallbackNotice(true);
        })
        .catch(() => {});
    }
    setSelectedWord({
      token: spoken || token,
      guide: findWordGuide(token),
    });
  }

  async function startRecordingFlow() {
    if (!segment || isRecording || savingTake) return;
    stopSpeaking();
    stopTakeAudio();
    setRecError(null);

    if (useCountdown) {
      for (const n of [3, 2, 1]) {
        setCountdownNum(n);
        await new Promise((r) => setTimeout(r, 650));
      }
      setCountdownNum(null);
    }

    try {
      const recorder = new PcmAudioRecorder();
      recorderRef.current = recorder;
      await recorder.start((level, elapsed) => {
        setMicLevel(level);
        setRecElapsed(elapsed);
      });
      setIsRecording(true);
    } catch (err) {
      setCountdownNum(null);
      setRecError(
        err instanceof Error
          ? err.message
          : 'No se pudo acceder al micrófono. Verifica los permisos del navegador.'
      );
    }
  }

  async function stopRecordingAndSave() {
    if (!recorderRef.current || !segment) return;
    setIsRecording(false);
    setSavingTake(true);
    setRecError(null);

    try {
      const rec = await recorderRef.current.stop();
      recorderRef.current = null;
      await persistNewTake(rec.blob, rec.durationSec, rec.peaks);
    } catch (err) {
      setRecError(
        err instanceof Error ? err.message : 'Error al guardar la grabación.'
      );
    } finally {
      setSavingTake(false);
      setMicLevel(0);
      setRecElapsed(0);
    }
  }

  async function cancelRecording() {
    await recorderRef.current?.cancel();
    recorderRef.current = null;
    setIsRecording(false);
    setMicLevel(0);
    setRecElapsed(0);
  }

  async function persistNewTake(wavBlob: Blob, durationSec: number, peaks: number[]) {
    if (!segment) return;
    const uploaded = await uploadAudioBlob(wavBlob, `${segment.id}.wav`);
    const nextNumber = segment.takes.length + 1;

    const newTake: Take = {
      id: `take-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      label: `Toma ${nextNumber}`,
      filename: uploaded.filename,
      audioUrl: uploaded.url,
      durationSec,
      peaks,
    };

    const updatedSegments = activeProject.segments.map((s) => {
      if (s.id !== segment.id) return s;
      const takes = [...s.takes, newTake];
      return {
        ...s,
        takes,
        selectedTakeId: s.selectedTakeId || newTake.id,
      };
    });

    const updatedProject: Project = {
      ...activeProject,
      segments: updatedSegments,
    };

    await onUpdateProject(updatedProject);

    if (autoEvaluate && hasApiKey) {
      await handleEvaluateTake(newTake, updatedProject, wavBlob);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !segment) return;

    setSavingTake(true);
    setRecError(null);
    try {
      const cleaned = await convertBlobToCleanWav(file);
      await persistNewTake(cleaned.wavBlob, cleaned.durationSec, cleaned.peaks);
    } catch (err) {
      setRecError(
        err instanceof Error
          ? err.message
          : 'No se pudo procesar ese archivo de audio. Prueba con .mp3 o .wav.'
      );
    } finally {
      setSavingTake(false);
    }
  }

  async function handlePlayTake(take: Take, seekSec?: number) {
    if (playingTakeId === take.id && seekSec === undefined) {
      stopTakeAudio(false);
      return;
    }

    stopSpeaking();
    const isSamePausedTake = takePlayhead?.takeId === take.id;
    stopTakeAudio(!isSamePausedTake && seekSec === undefined);
    setRecError(null);

    try {
      const [buffer, ctx] = await Promise.all([
        fetchAudioBuffer(take.audioUrl),
        ensureAudioContextRunning(),
      ]);

      const maxStart = Math.max(0, buffer.duration - 0.05);
      let startAt = 0;
      if (seekSec !== undefined) {
        startAt = Math.max(0, Math.min(maxStart, seekSec));
      } else if (isSamePausedTake && takePlayhead && takePlayhead.sec < maxStart) {
        startAt = Math.max(0, takePlayhead.sec);
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      takeSourceRef.current = source;
      setPlayingTakeId(take.id);
      setTakePlayhead({ takeId: take.id, sec: startAt });
      const startedCtxTime = ctx.currentTime;

      source.onended = () => {
        if (takeSourceRef.current === source) {
          stopTakeAudio(true);
        }
      };

      const tick = () => {
        if (takeSourceRef.current !== source) return;
        const pos = Math.min(buffer.duration, startAt + (ctx.currentTime - startedCtxTime));
        setTakePlayhead({ takeId: take.id, sec: pos });
        if (pos < buffer.duration) {
          takeRafRef.current = requestAnimationFrame(tick);
        }
      };
      takeRafRef.current = requestAnimationFrame(tick);

      source.start(0, startAt);
    } catch (err) {
      stopTakeAudio(true);
      setRecError(
        err instanceof Error
          ? err.message
          : 'No se pudo reproducir esta grabación.'
      );
    }
  }

  async function handleSelectTake(takeId: string) {
    if (!segment) return;
    const updatedSegments = activeProject.segments.map((s) =>
      s.id === segment.id ? { ...s, selectedTakeId: takeId } : s
    );
    await onUpdateProject({ ...activeProject, segments: updatedSegments });
  }

  async function handleDeleteTake(take: Take) {
    if (!segment) return;
    if (playingTakeId === take.id || takePlayhead?.takeId === take.id) {
      stopTakeAudio(true);
    }

    evictAudioBufferCache(take.audioUrl);
    try {
      await deleteAudioApi(take.filename);
    } catch {
      // File may already be missing; proceed with metadata removal
    }

    const updatedSegments = activeProject.segments.map((s) => {
      if (s.id !== segment.id) return s;
      const remaining = s.takes.filter((t) => t.id !== take.id);
      const nextSelected =
        s.selectedTakeId === take.id ? remaining[0]?.id || null : s.selectedTakeId;
      return {
        ...s,
        takes: remaining,
        selectedTakeId: nextSelected,
      };
    });

    await onUpdateProject({ ...activeProject, segments: updatedSegments });
  }

  async function handleEvaluateTake(
    take: Take,
    baseProjectOverride?: Project,
    blobOverride?: Blob
  ) {
    const baseProject = baseProjectOverride || activeProject;
    const targetSeg =
      baseProject.segments.find((s) => s.takes.some((t) => t.id === take.id)) ||
      segment;
    if (!targetSeg) return;

    setEvaluatingTakeId(take.id);
    setEvalError(null);
    try {
      let blob = blobOverride;
      if (!blob) {
        blob = await loadAudioBlobFromUrl(take.audioUrl);
      }
      const wavChunks = await convertToAsrWavChunks(blob, 110);
      const result = await evaluateAudioApi({
        wavChunks,
        expectedText: targetSeg.text,
        ignoreParentheses: true,
        saveHistory: false,
      });

      const updatedSegments = baseProject.segments.map((s) => {
        if (s.id !== targetSeg.id) return s;
        const nextTakes = s.takes.map((t) =>
          t.id === take.id ? { ...t, evaluation: result } : t
        );
        const currSelected = nextTakes.find((t) => t.id === s.selectedTakeId);
        const currSelectedScore = currSelected?.evaluation?.score ?? -1;
        const shouldPromote =
          !s.selectedTakeId || result.score > currSelectedScore;

        return {
          ...s,
          takes: nextTakes,
          selectedTakeId: shouldPromote ? take.id : s.selectedTakeId,
        };
      });

      await onUpdateProject({ ...baseProject, segments: updatedSegments });
    } catch (err) {
      setEvalError(
        err instanceof Error
          ? err.message
          : 'No se pudo evaluar la grabación con IA.'
      );
    } finally {
      setEvaluatingTakeId(null);
    }
  }

  async function handleAddManualPart(e: React.FormEvent) {
    e.preventDefault();
    const text = manualPartText.trim();
    if (!text) return;

    const order = activeProject.segments.length + 1;
    const newSeg: ScriptSegment = {
      id: `seg-${crypto.randomUUID().slice(0, 8)}`,
      order,
      title: `Parte ${order}`,
      text,
      cueBefore: '',
      cueAfter: '',
      pauseAfterSec: 0.5,
      phoneticEs: '',
      translationEs: '',
      tipsEs: ['Escucha la frase despacio primero y luego graba tu voz.'],
      words: [],
      takes: [],
      selectedTakeId: null,
    };

    await onUpdateProject({
      ...activeProject,
      segments: [...activeProject.segments, newSeg],
    });
    setManualPartText('');
    setAddingManualPart(false);
    setActiveSegmentIdx(activeProject.segments.length);
  }

  async function handleResetOrDeleteProject() {
    if (activeProject.id === 'sofia-birthday-v1') {
      if (!window.confirm('¿Reiniciar el guion de Sofía (se borrarán sus tomas grabadas)?')) {
        return;
      }
      const reset = await resetProjectApi('sofia-birthday-v1');
      await onUpdateProject(reset);
      setActiveSegmentIdx(0);
    } else {
      if (!window.confirm(`¿Eliminar el proyecto "${activeProject.title}"?`)) {
        return;
      }
      await deleteProjectApi(activeProject.id);
      onRemoveProject(activeProject.id);
    }
  }

  async function handleFinishAndNew() {
    if (activeProject.id === 'sofia-birthday-v1') {
      if (
        !window.confirm(
          '¿Reiniciar el guion de Sofía y empezar uno nuevo? Se borrarán sus tomas grabadas.'
        )
      ) {
        return;
      }
      const reset = await resetProjectApi('sofia-birthday-v1');
      await onUpdateProject(reset);
    } else {
      if (
        !window.confirm(
          `¿Terminar "${activeProject.title}"? Se borrarán el guion y sus audios para empezar uno nuevo.`
        )
      ) {
        return;
      }
      await deleteProjectApi(activeProject.id);
      onRemoveProject(activeProject.id);
    }
    setActiveSegmentIdx(0);
    setShowNewModal(true);
  }

  function getBestScore(seg: ScriptSegment): number | null {
    const scores = seg.takes
      .map((t) => t.evaluation?.score)
      .filter((n): n is number => typeof n === 'number');
    return scores.length > 0 ? Math.max(...scores) : null;
  }

  function selectFocus(speaker: string | null) {
    setFocusSpeaker(speaker);
    if (speaker) {
      const firstIdx = segments.findIndex(
        (seg) => !seg.speaker || seg.speaker === speaker
      );
      if (firstIdx >= 0) setActiveSegmentIdx(firstIdx);
    }
  }

  function hasFocusStep(direction: 1 | -1): boolean {
    let next = safeIdx + direction;
    while (next >= 0 && next < segments.length) {
      const seg = segments[next];
      if (!focusSpeaker || !seg.speaker || seg.speaker === focusSpeaker) return true;
      next += direction;
    }
    return false;
  }

  function stepSegment(direction: 1 | -1) {
    setActiveSegmentIdx((current) => {
      let next = current + direction;
      while (next >= 0 && next < segments.length) {
        const seg = segments[next];
        if (!focusSpeaker || !seg.speaker || seg.speaker === focusSpeaker) return next;
        next += direction;
      }
      return current;
    });
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* LEFT SIDEBAR: Project & Parts list */}
      <aside className="lg:col-span-4 space-y-4">
        <div className="rounded-2xl bg-white border border-slate-200 shadow-xs p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Guion activo
            </span>
            <button
              onClick={() => setShowNewModal(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-700 hover:bg-indigo-100 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Nuevo texto
            </button>
          </div>

          <select
            value={activeProject.id}
            onChange={(e) => onSelectProject(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-800 focus:border-indigo-500 focus:outline-none"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.segments.length} partes)
              </option>
            ))}
          </select>

          {speakers.length > 1 && (
            <div className="space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Practicar rol
              </span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => selectFocus(null)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-bold cursor-pointer ${
                    focusSpeaker === null
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  Todos
                </button>
                {speakers.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    onClick={() => selectFocus(sp)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-bold cursor-pointer ${
                      focusSpeaker === sp
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {sp}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Progress */}
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-600">
                Progreso de grabación
              </span>
              <span className="font-bold text-indigo-700">
                {readyCount} de {segments.length} listas
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                style={{
                  width: `${
                    segments.length > 0 ? Math.round((readyCount / segments.length) * 100) : 0
                  }%`,
                }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              onClick={onGoToStudio}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 cursor-pointer"
            >
              Unir en Estudio ({readyCount})
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleResetOrDeleteProject}
              title={
                activeProject.id === 'sofia-birthday-v1'
                  ? 'Reiniciar guion original'
                  : 'Eliminar guion'
              }
              className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 cursor-pointer"
            >
              {activeProject.id === 'sofia-birthday-v1' ? (
                <RotateCcw className="w-4 h-4" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
            </button>
          </div>

          <button
            onClick={handleFinishAndNew}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-100 cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Terminar y crear nuevo guion
          </button>
        </div>

        {/* Parts list */}
        <div className="rounded-2xl bg-white border border-slate-200 shadow-xs overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-sm font-extrabold text-slate-800">
              Partes pequeñas ({segments.length})
            </h2>
            <button
              onClick={() => setAddingManualPart((v) => !v)}
              className="text-xs font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer"
            >
              + Agregar parte
            </button>
          </div>

          {addingManualPart && (
            <form
              onSubmit={handleAddManualPart}
              className="p-3 bg-indigo-50/70 border-b border-indigo-100 space-y-2"
            >
              <textarea
                rows={2}
                value={manualPartText}
                onChange={(e) => setManualPartText(e.target.value)}
                placeholder="Escribe una frase corta en inglés..."
                className="w-full rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-xs focus:outline-none"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setAddingManualPart(false)}
                  className="px-2.5 py-1 text-xs font-semibold text-slate-600"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-bold text-white"
                >
                  Guardar
                </button>
              </div>
            </form>
          )}

          <div className="max-h-[540px] overflow-y-auto divide-y divide-slate-100">
            {segments.map((seg, idx) => {
              const isActive = idx === safeIdx;
              const isReady = Boolean(seg.selectedTakeId);
              const best = getBestScore(seg);
              const matches = matchesFocus(seg);

              return (
                <button
                  key={seg.id}
                  onClick={() => setActiveSegmentIdx(idx)}
                  disabled={!matches}
                  className={`w-full text-left px-4 py-3 transition flex items-start gap-3 ${
                    matches ? 'cursor-pointer' : 'opacity-30 cursor-not-allowed'
                  } ${
                    isActive
                      ? 'bg-indigo-50/90 border-l-4 border-l-indigo-600'
                      : matches
                      ? 'hover:bg-slate-50'
                      : ''
                  }`}
                >
                  <div
                    className={`mt-0.5 w-6 h-6 rounded-full text-xs font-extrabold flex items-center justify-center shrink-0 ${
                      isReady
                        ? 'bg-emerald-100 text-emerald-700'
                        : isActive
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {isReady ? <CheckCircle2 className="w-4 h-4" /> : idx + 1}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-xs font-bold truncate ${
                          isActive ? 'text-indigo-900' : 'text-slate-800'
                        }`}
                      >
                        {seg.title}
                      </span>
                      {best !== null && (
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-extrabold ${
                            best >= 85
                              ? 'bg-emerald-100 text-emerald-800'
                              : best >= 60
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          {best}%
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 line-clamp-2 mt-0.5">{seg.text}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1 text-[11px] text-slate-400">
                      <span>
                        {seg.takes.length === 0
                          ? 'Sin grabaciones'
                          : `${seg.takes.length} toma${seg.takes.length > 1 ? 's' : ''}`}
                      </span>
                      {seg.speaker && (
                        <span className="rounded bg-indigo-100 text-indigo-800 px-1.5 py-0.5 font-bold">
                          {seg.speaker}
                        </span>
                      )}
                      {(seg.cueBefore || seg.cueAfter) && (
                        <span className="rounded bg-amber-50 text-amber-800 px-1.5 py-0.5 font-medium">
                          {seg.cueBefore || seg.cueAfter}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* MAIN AREA: Focused practice & recording */}
      <section className="lg:col-span-8 space-y-5">
        {segment && (
          <>
            {/* Card 1: Teleprompter (Reading + Listening + Recording all together) */}
            <div className="rounded-2xl bg-white border border-slate-200 shadow-xs p-5 space-y-4">
              {/* Top title & quick navigation */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-indigo-600">
                    Parte {safeIdx + 1} de {segments.length}
                  </span>
                  <h2 className="text-lg sm:text-xl font-extrabold text-slate-900 flex items-center gap-2">
                    {segment.speaker ? (
                      <span className="rounded-full bg-indigo-100 text-indigo-800 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">
                        {segment.speaker}
                      </span>
                    ) : null}
                    {segment.title}
                  </h2>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => stepSegment(-1)}
                    disabled={!hasFocusStep(-1)}
                    title="Parte anterior"
                    className="rounded-xl border border-slate-200 bg-slate-50 p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-35 cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => stepSegment(1)}
                    disabled={!hasFocusStep(1)}
                    title="Siguiente parte"
                    className="rounded-xl border border-slate-200 bg-slate-50 p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-35 cursor-pointer"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setEasyReadMode((v) => !v)}
                    className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                      easyReadMode
                        ? 'bg-indigo-600 border-indigo-600 text-white shadow-xs'
                        : 'bg-indigo-50 border-indigo-200 text-indigo-800 hover:bg-indigo-100'
                    }`}
                    title="Pone la pronunciación corrida en tamaño gigante arriba para leerla sin trabarse"
                  >
                    🎯 {easyReadMode ? 'Lectura fácil: Activa' : 'Lectura fácil (solo español grande)'}
                  </button>
                  <button
                    onClick={() => setShowSpanishHelp((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 cursor-pointer"
                  >
                    {showSpanishHelp ? (
                      <>
                        <EyeOff className="w-3.5 h-3.5" /> Ocultar guía español
                      </>
                    ) : (
                      <>
                        <Eye className="w-3.5 h-3.5" /> Mostrar guía español
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Stage cues (not read aloud) */}
              {(segment.cueBefore || segment.cueAfter) && (
                <div className="flex flex-wrap gap-2">
                  {segment.cueBefore && (
                    <span className="inline-flex items-center gap-1.5 rounded-xl bg-amber-50 border border-amber-200 px-3 py-1 text-xs font-bold text-amber-900">
                      🎭 Indicaciones para leer: {segment.cueBefore}
                    </span>
                  )}
                  {segment.cueAfter && (
                    <span className="inline-flex items-center gap-1.5 rounded-xl bg-sky-50 border border-sky-200 px-3 py-1 text-xs font-bold text-sky-900">
                      ⏸️ Al terminar: {segment.cueAfter} (no se lee en voz alta)
                    </span>
                  )}
                </div>
              )}

              {/* Teleprompter Block: Clickable English + Spanish Phonetics */}
              <div
                className={`rounded-2xl border p-4 space-y-3 transition ${
                  isRecording || countdownNum !== null
                    ? 'ring-2 ring-rose-400 border-rose-300 bg-rose-50/30'
                    : 'border-slate-200 bg-slate-50/90'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-500 flex items-center gap-1">
                    <HelpCircle className="w-3.5 h-3.5 text-indigo-500" />
                    Toca cualquier palabra para escucharla y ver cómo se pronuncia
                  </span>
                  {(isRecording || countdownNum !== null) && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-2.5 py-0.5 text-[11px] font-extrabold text-white animate-pulse">
                      <span className="w-2 h-2 rounded-full bg-white" />
                      EN VIVO · Lee este texto
                    </span>
                  )}
                </div>

                {easyReadMode && segment.phoneticEs ? (
                  <>
                    <div className="rounded-xl bg-indigo-50 border border-indigo-200 p-4 space-y-2">
                      <div className="text-xs font-extrabold uppercase tracking-wider text-indigo-700">
                        Léelo corrido, sin pausar entre sílabas:
                      </div>
                      <p className="text-2xl sm:text-3xl font-extrabold text-indigo-950 leading-relaxed">
                        {segment.phoneticEs}
                      </p>
                      {showSpanishHelp && segment.translationEs && (
                        <div className="text-xs sm:text-sm text-slate-700 pt-2 border-t border-indigo-200/80">
                          <span className="font-bold text-slate-500">Significado: </span>
                          <span className="font-medium">{segment.translationEs}</span>
                        </div>
                      )}
                    </div>

                    <div className="pt-1">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                        Texto original en inglés (toca cualquier palabra para oírla):
                      </div>
                      <p className="text-base sm:text-lg font-semibold leading-relaxed text-slate-700 flex flex-wrap gap-x-1.5 gap-y-1">
                        {tokens.map((token, idx) => {
                          const isHighlighted = activeWordIndex === idx;
                          return (
                            <button
                              key={`${token}-${idx}`}
                              type="button"
                              onClick={() => handleWordClick(token)}
                              className={`rounded-lg px-1.5 py-0.5 transition cursor-pointer ${
                                isHighlighted
                                  ? 'bg-indigo-600 text-white scale-105 shadow-sm'
                                  : 'hover:bg-indigo-100 hover:text-indigo-900'
                              }`}
                            >
                              {token}
                            </button>
                          );
                        })}
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xl sm:text-2xl font-bold leading-relaxed text-slate-900 flex flex-wrap gap-x-2 gap-y-1">
                      {tokens.map((token, idx) => {
                        const isHighlighted = activeWordIndex === idx;
                        return (
                          <button
                            key={`${token}-${idx}`}
                            type="button"
                            onClick={() => handleWordClick(token)}
                            className={`rounded-lg px-1.5 py-0.5 transition cursor-pointer ${
                              isHighlighted
                                ? 'bg-indigo-600 text-white scale-105 shadow-sm'
                                : 'hover:bg-indigo-100 hover:text-indigo-900'
                            }`}
                          >
                            {token}
                          </button>
                        );
                      })}
                    </p>

                    {showSpanishHelp && (segment.phoneticEs || segment.translationEs) && (
                      <div className="space-y-1.5 rounded-xl bg-indigo-50/75 border border-indigo-100 p-3.5">
                        {segment.phoneticEs && (
                          <div>
                            <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-700">
                              Léelo corrido así:{' '}
                            </span>
                            <p className="text-lg sm:text-xl font-bold text-indigo-950 leading-relaxed mt-0.5">
                              {segment.phoneticEs}
                            </p>
                          </div>
                        )}
                        {segment.translationEs && (
                          <div className="text-xs sm:text-sm text-slate-700 pt-1 border-t border-indigo-100/90">
                            <span className="font-bold text-slate-500">Significado: </span>
                            <span className="font-medium">{segment.translationEs}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Unified Listen + Record Controls (always visible directly under the script) */}
              <div className="space-y-3 pt-1">
                {/* Row 1: Listen & speed */}
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => handlePlayPhrase(false)}
                      className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs sm:text-sm font-bold transition cursor-pointer ${
                        isPlayingGuide && !isLooping
                          ? 'bg-rose-600 text-white hover:bg-rose-700'
                          : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-xs'
                      }`}
                    >
                      {isPlayingGuide && !isLooping ? (
                        <>
                          <Square className="w-4 h-4 fill-current" /> Detener
                        </>
                      ) : (
                        <>
                          <Volume2 className="w-4 h-4" /> Escuchar frase
                        </>
                      )}
                    </button>

                    <button
                      onClick={() => handlePlayPhrase(true)}
                      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs sm:text-sm font-bold border transition cursor-pointer ${
                        isLooping
                          ? 'bg-indigo-100 border-indigo-300 text-indigo-900'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <Repeat className="w-3.5 h-3.5" />
                      {isLooping ? 'Repitiendo...' : 'Repetir'}
                    </button>

                    <button
                      onClick={handleWordByWord}
                      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs sm:text-sm font-bold border transition cursor-pointer ${
                        isWordMode
                          ? 'bg-amber-100 border-amber-300 text-amber-900'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <Wand2 className="w-3.5 h-3.5" />
                      {isWordMode ? 'Detener guía' : 'Palabra por palabra'}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-1">
                    {SPEED_OPTIONS.map((opt) => (
                      <button
                        key={opt.rate}
                        onClick={() => setSpeedRate(opt.rate)}
                        className={`rounded-lg px-2 py-1 text-[11px] font-bold transition cursor-pointer ${
                          Math.abs(speedRate - opt.rate) < 0.06
                            ? 'bg-slate-900 text-white'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Row 2: Direct Recording Bar right under the script */}
                <div className="rounded-2xl bg-slate-50 border border-slate-200 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  {countdownNum !== null ? (
                    <div className="flex items-center gap-3 w-full justify-center py-1">
                      <span className="w-9 h-9 rounded-full bg-indigo-600 text-white text-lg font-extrabold flex items-center justify-center animate-bounce">
                        {countdownNum}
                      </span>
                      <span className="text-sm font-bold text-indigo-900">
                        Prepárate para leer el texto de arriba...
                      </span>
                    </div>
                  ) : isRecording ? (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 w-full">
                      <div className="flex items-center gap-3 flex-1">
                        <div className="relative flex items-center justify-center w-9 h-9 shrink-0">
                          <span className="absolute inset-0 rounded-full bg-rose-400 animate-soft-pulse" />
                          <span className="relative w-3.5 h-3.5 rounded-full bg-rose-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between text-xs font-bold text-rose-700 mb-1">
                            <span>Grabando ahora... lee la frase de arriba</span>
                            <span className="font-mono">{formatTime(recElapsed)}</span>
                          </div>
                          <div className="h-2.5 w-full rounded-full bg-rose-100 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-rose-500 transition-all duration-75"
                              style={{ width: `${Math.max(6, Math.round(micLevel * 100))}%` }}
                            />
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={cancelRecording}
                          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 cursor-pointer"
                        >
                          Cancelar
                        </button>
                        <button
                          onClick={stopRecordingAndSave}
                          className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700 cursor-pointer shadow-xs"
                        >
                          <Square className="w-4 h-4 fill-current" />
                          Detener y guardar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <button
                          onClick={startRecordingFlow}
                          disabled={savingTake}
                          className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-60 cursor-pointer shadow-xs"
                        >
                          {savingTake ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Guardando audio...
                            </>
                          ) : (
                            <>
                              <Mic className="w-4 h-4" />
                              Grabar esta parte
                            </>
                          )}
                        </button>

                        <button
                          onClick={() => uploadInputRef.current?.click()}
                          disabled={savingTake}
                          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-xs sm:text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60 cursor-pointer"
                        >
                          <Upload className="w-4 h-4" />
                          Subir audio
                        </button>
                        <input
                          ref={uploadInputRef}
                          type="file"
                          accept="audio/*"
                          className="hidden"
                          onChange={handleFileUpload}
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-4">
                        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={autoEvaluate}
                            onChange={(e) => setAutoEvaluate(e.target.checked)}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          Auto-evaluar al grabar
                        </label>
                        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={useCountdown}
                            onChange={(e) => setUseCountdown(e.target.checked)}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          Cuenta regresiva 3-2-1
                        </label>
                      </div>
                    </>
                  )}
                </div>

                {recError && (
                  <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-2 text-xs text-rose-800">
                    {recError}
                  </div>
                )}

                {fallbackNotice && !hasApiKey && (
                  <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                    <span>
                      Estás escuchando la voz rápida del navegador porque aún no has agregado
                      tu API Key de DeepSeek.
                    </span>
                    {onOpenSettings && (
                      <button
                        type="button"
                        onClick={onOpenSettings}
                        className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-amber-700 cursor-pointer shrink-0"
                      >
                        Configurar API Key
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Tips section below controls so it never pushes the Record button down */}
              {showSpanishHelp && segment.tipsEs && segment.tipsEs.length > 0 && (
                <details className="rounded-xl bg-emerald-50/70 border border-emerald-200/80 px-4 py-2.5">
                  <summary className="text-xs font-bold text-emerald-900 flex items-center gap-1.5 cursor-pointer select-none">
                    <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
                    Trucos fáciles de pronunciación para esta parte ({segment.tipsEs.length})
                  </summary>
                  <ul className="list-disc list-inside text-xs sm:text-sm text-slate-700 space-y-1 mt-2">
                    {segment.tipsEs.map((tip, i) => (
                      <li key={i}>{tip}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>

            {/* Card 2: Takes List & Navigation */}
            <div className="rounded-2xl bg-white border border-slate-200 shadow-xs p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-base font-extrabold text-slate-900">
                    Tus grabaciones de esta parte ({segment.takes.length})
                  </h3>
                  <p className="text-xs text-slate-500">
                    Escucha tus tomas, evalúalas con IA y marca con estrella la mejor para el estudio.
                  </p>
                </div>
              </div>

              {evalError && (
                <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-2.5 text-xs text-rose-800 flex flex-wrap items-center justify-between gap-2">
                  <span>{evalError}</span>
                  {!hasApiKey && onOpenSettings && (
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-rose-700 cursor-pointer shrink-0"
                    >
                      Configurar API Key
                    </button>
                  )}
                </div>
              )}

              {evaluatingTakeId && !segment.takes.some((t) => t.id === evaluatingTakeId && t.evaluation) && (
                <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-4 py-2.5 text-xs font-bold text-indigo-900 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
                  Evaluando tu nueva grabación y comparándola con tus intentos anteriores...
                </div>
              )}

              {segment.takes.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-4 text-center text-xs text-slate-500">
                  Aún no has grabado esta parte. Pulsa <strong>"Grabar esta parte"</strong> arriba mientras lees el texto.
                </div>
              ) : (
                (() => {
                  const evaluatedChrono = segment.takes.filter((t) => Boolean(t.evaluation));
                  const comparisonByTakeId = new Map<string, EvaluationComparison>();
                  let bestScoreSoFar = -Infinity;
                  const bestTakeId =
                    evaluatedChrono.length > 0
                      ? evaluatedChrono.reduce((best, curr) =>
                          (curr.evaluation?.score ?? -1) > (best.evaluation?.score ?? -1)
                            ? curr
                            : best
                        ).id
                      : null;

                  evaluatedChrono.forEach((t, idx) => {
                    const currEval = t.evaluation!;
                    if (idx > 0) {
                      const prevTake = evaluatedChrono[idx - 1];
                      comparisonByTakeId.set(
                        t.id,
                        compareEvaluations(currEval, prevTake.evaluation!, {
                          previousBestScore: bestScoreSoFar,
                          previousLabel: prevTake.label,
                        })
                      );
                    }
                    if (currEval.score > bestScoreSoFar) {
                      bestScoreSoFar = currEval.score;
                    }
                  });

                  const firstScore = evaluatedChrono[0]?.evaluation?.score;
                  const lastScore =
                    evaluatedChrono[evaluatedChrono.length - 1]?.evaluation?.score;
                  const totalGain =
                    evaluatedChrono.length >= 2 &&
                    firstScore !== undefined &&
                    lastScore !== undefined
                      ? lastScore - firstScore
                      : null;

                  const takesNewestFirst = [...segment.takes].reverse();

                  return (
                    <div className="space-y-3">
                      {evaluatedChrono.length > 0 && (
                        <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-extrabold text-slate-700 flex items-center gap-1.5">
                              <TrendingUp className="w-4 h-4 text-indigo-600" />
                              Evolución de tus intentos
                            </span>
                            {totalGain !== null && (
                              <span
                                className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${
                                  totalGain > 0
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : totalGain === 0
                                    ? 'bg-slate-200 text-slate-700'
                                    : 'bg-amber-100 text-amber-800'
                                }`}
                              >
                                {totalGain > 0
                                  ? `Mejora acumulada: +${totalGain}%`
                                  : totalGain === 0
                                  ? 'Mismo puntaje'
                                  : `Diferencia vs 1.ª toma: ${totalGain}%`}
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            {evaluatedChrono.map((t, idx) => {
                              const sc = t.evaluation!.score;
                              const comp = comparisonByTakeId.get(t.id);
                              const isBest = t.id === bestTakeId && evaluatedChrono.length > 1;
                              return (
                                <React.Fragment key={t.id}>
                                  {idx > 0 && (
                                    <span className="text-slate-400 font-bold">→</span>
                                  )}
                                  <span
                                    className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-bold ${
                                      isBest
                                        ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                                        : 'bg-white border-slate-200 text-slate-700'
                                    }`}
                                  >
                                    <span>{t.label}</span>
                                    <span className="font-extrabold">({sc}%</span>
                                    {comp && comp.delta !== 0 && (
                                      <span
                                        className={
                                          comp.delta > 0
                                            ? 'text-emerald-700'
                                            : 'text-amber-700'
                                        }
                                      >
                                        {comp.delta > 0 ? `+${comp.delta}%` : `${comp.delta}%`}
                                      </span>
                                    )}
                                    <span>)</span>
                                    {isBest && <Trophy className="w-3 h-3 text-emerald-600" />}
                                  </span>
                                </React.Fragment>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {takesNewestFirst.map((take) => {
                        const isSelected = segment.selectedTakeId === take.id;
                        const isPlaying = playingTakeId === take.id;
                        const isEvaluating = evaluatingTakeId === take.id;
                        const comparison = comparisonByTakeId.get(take.id) || null;
                        const isBest = take.id === bestTakeId && evaluatedChrono.length > 1;

                        return (
                          <div
                            key={take.id}
                            className={`rounded-2xl border p-4 space-y-3 transition ${
                              isSelected
                                ? 'border-emerald-300 bg-emerald-50/40'
                                : 'border-slate-200 bg-white'
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2.5">
                                <button
                                  onClick={() => handlePlayTake(take)}
                                  className="w-9 h-9 rounded-full bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-700 cursor-pointer shrink-0"
                                  title={isPlaying ? 'Pausar' : 'Escuchar tu toma'}
                                >
                                  {isPlaying ? (
                                    <Pause className="w-4 h-4" />
                                  ) : (
                                    <Play className="w-4 h-4 ml-0.5" />
                                  )}
                                </button>
                                <div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-bold text-slate-900">
                                      {take.label}
                                    </span>
                                    <span className="text-xs font-mono text-slate-500">
                                      {takePlayhead?.takeId === take.id
                                        ? `${formatTime(takePlayhead.sec)} / ${formatTime(take.durationSec)}`
                                        : formatTime(take.durationSec)}
                                    </span>
                                    {take.evaluation && (
                                      <span
                                        className={`rounded-full px-2 py-0.5 text-xs font-extrabold ${
                                          take.evaluation.score >= 85
                                            ? 'bg-emerald-100 text-emerald-800'
                                            : take.evaluation.score >= 60
                                            ? 'bg-amber-100 text-amber-800'
                                            : 'bg-rose-100 text-rose-800'
                                        }`}
                                      >
                                        {take.evaluation.score}%
                                      </span>
                                    )}
                                    {comparison && comparison.delta !== 0 && (
                                      <span
                                        className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold ${
                                          comparison.delta > 0
                                            ? 'bg-emerald-100 text-emerald-800'
                                            : 'bg-amber-100 text-amber-800'
                                        }`}
                                      >
                                        {comparison.delta > 0
                                          ? `+${comparison.delta}%`
                                          : `${comparison.delta}%`}
                                      </span>
                                    )}
                                    {isBest && (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-900 px-2 py-0.5 text-[11px] font-extrabold">
                                        <Trophy className="w-3 h-3 text-amber-600" /> Mejor
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  onClick={() => handleSelectTake(take.id)}
                                  className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold border transition cursor-pointer ${
                                    isSelected
                                      ? 'bg-emerald-600 border-emerald-600 text-white'
                                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                                  }`}
                                >
                                  <Star className={`w-3.5 h-3.5 ${isSelected ? 'fill-current' : ''}`} />
                                  {isSelected ? 'Elegida para el estudio' : 'Elegir como final'}
                                </button>

                                <button
                                  onClick={() => handleEvaluateTake(take)}
                                  disabled={isEvaluating}
                                  className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-50 border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-800 hover:bg-indigo-100 disabled:opacity-60 cursor-pointer"
                                >
                                  {isEvaluating ? (
                                    <>
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      Evaluando...
                                    </>
                                  ) : (
                                    <>
                                      <Sparkles className="w-3.5 h-3.5" />
                                      {take.evaluation ? 'Re-evaluar IA' : 'Evaluar con IA'}
                                    </>
                                  )}
                                </button>

                                <button
                                  onClick={() => handleDeleteTake(take)}
                                  className="rounded-xl p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 cursor-pointer"
                                  title="Eliminar esta toma"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>

                            <WaveformCanvas
                              peaks={take.peaks}
                              durationSec={take.durationSec}
                              playheadSec={
                                takePlayhead?.takeId === take.id
                                  ? takePlayhead.sec
                                  : null
                              }
                              onSeek={(sec) => handlePlayTake(take, sec)}
                              showTimeLabels
                              height={48}
                            />

                            {take.evaluation && (
                              <EvaluationCard
                                result={take.evaluation}
                                voiceId={voiceId}
                                compact
                                comparison={comparison}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()
              )}

              {/* Prev / Next Navigation */}
              <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                <button
                  onClick={() => stepSegment(-1)}
                  disabled={!hasFocusStep(-1)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Parte anterior
                </button>

                {hasFocusStep(1) ? (
                  <button
                    onClick={() => stepSegment(1)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800 cursor-pointer"
                  >
                    Siguiente parte
                    <ArrowRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    onClick={onGoToStudio}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 cursor-pointer"
                  >
                    Ir al Estudio y unir todo
                    <ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {selectedWord && segment && (
        <WordPopover
          word={selectedWord.token}
          contextSentence={segment.text}
          localGuide={selectedWord.guide}
          voiceId={voiceId}
          onClose={() => setSelectedWord(null)}
        />
      )}

      {showNewModal && (
        <NewScriptModal
          onClose={() => setShowNewModal(false)}
          onCreated={(proj) => {
            onAddProject(proj);
            setShowNewModal(false);
          }}
        />
      )}
    </div>
  );
};
