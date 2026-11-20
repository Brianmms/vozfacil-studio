import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  FileAudio,
  History,
  Loader2,
  Mic,
  SearchCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react';
import type { EvaluationResult, Project, VoiceId } from '../types';
import {
  deleteEvaluationApi,
  evaluateAudioApi,
  fetchEvaluations,
  prepareScriptApi,
} from '../lib/api';
import { cleanExpectedText } from '../lib/scriptParser';
import { PcmAudioRecorder } from '../lib/audioRecorder';
import { convertToAsrWavChunks, decodeAudioBlob, formatTime } from '../lib/audioUtils';
import { speakEnglishText, stopAllSpeech } from '../lib/ttsPlayer';
import { compareEvaluations, normalizeCompareText } from '../lib/progressCompare';
import { EvaluationCard } from './EvaluationCard';

interface EvaluatorViewProps {
  voiceId: VoiceId;
  sofiaFullText: string;
  hasApiKey: boolean;
  onImportProject: (project: Project) => void;
  onOpenSettings?: () => void;
}

export const EvaluatorView: React.FC<EvaluatorViewProps> = ({
  voiceId,
  sofiaFullText,
  hasApiKey,
  onImportProject,
  onOpenSettings,
}) => {
  const [text, setText] = useState(sofiaFullText);
  const [ignoreParentheses, setIgnoreParentheses] = useState(true);

  // Audio source (uploaded or recorded)
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioLabel, setAudioLabel] = useState<string>('');
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [recElapsed, setRecElapsed] = useState(0);
  const recorderRef = useRef<PcmAudioRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Listen & Phonetics guide
  const [isListeningText, setIsListeningText] = useState(false);
  const [loadingGuide, setLoadingGuide] = useState(false);
  const [sendingToPractice, setSendingToPractice] = useState(false);
  const [phoneticPreview, setPhoneticPreview] = useState<Project | null>(null);

  // Evaluation state
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [history, setHistory] = useState<EvaluationResult[]>([]);

  useEffect(() => {
    fetchEvaluations()
      .then(setHistory)
      .catch(() => {});

    return () => {
      stopAllSpeech();
      recorderRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    };
  }, [audioPreviewUrl]);

  function setLoadedAudio(blob: Blob, label: string, knownDuration?: number) {
    if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    const url = URL.createObjectURL(blob);
    setAudioBlob(blob);
    setAudioLabel(label);
    setAudioPreviewUrl(url);
    setEvalError(null);

    if (knownDuration !== undefined) {
      setAudioDuration(knownDuration);
    } else {
      decodeAudioBlob(blob)
        .then((buf) => setAudioDuration(buf.duration))
        .catch(() => setAudioDuration(null));
    }
  }

  function handleFileSelected(file: File | undefined) {
    if (!file) return;
    setLoadedAudio(file, file.name);
  }

  async function handleStartRecord() {
    if (isRecording) return;
    setEvalError(null);
    stopAllSpeech();
    setIsListeningText(false);
    try {
      const rec = new PcmAudioRecorder();
      recorderRef.current = rec;
      await rec.start((lvl, elapsed) => {
        setMicLevel(lvl);
        setRecElapsed(elapsed);
      });
      setIsRecording(true);
    } catch (err) {
      setEvalError(
        err instanceof Error ? err.message : 'No se pudo activar el micrófono.'
      );
    }
  }

  async function handleStopRecord() {
    if (!recorderRef.current) return;
    setIsRecording(false);
    const res = await recorderRef.current.stop();
    recorderRef.current = null;
    setMicLevel(0);
    setRecElapsed(0);
    setLoadedAudio(res.blob, 'Grabación directa (.wav)', res.durationSec);
  }

  async function handleListenText() {
    if (isListeningText) {
      stopAllSpeech();
      setIsListeningText(false);
      return;
    }
    const clean = cleanExpectedText(text);
    if (!clean) return;
    setIsListeningText(true);
    try {
      await speakEnglishText(clean.slice(0, 1200), { voiceId, rate: 0.85 });
    } finally {
      setIsListeningText(false);
    }
  }

  async function handleGenerateGuide() {
    if (!text.trim()) return;
    setLoadingGuide(true);
    setEvalError(null);
    try {
      const res = await prepareScriptApi({
        title: 'Texto evaluado',
        rawText: text.trim(),
        save: false,
      });
      setPhoneticPreview(res.project);
    } catch (err) {
      setEvalError(
        err instanceof Error ? err.message : 'No se pudo generar la guía fonética.'
      );
    } finally {
      setLoadingGuide(false);
    }
  }

  async function handleSendToPractice() {
    if (!text.trim()) return;
    setSendingToPractice(true);
    setEvalError(null);
    try {
      const res = await prepareScriptApi({
        title: `Práctica (${new Date().toLocaleDateString()})`,
        rawText: text.trim(),
        save: true,
      });
      onImportProject(res.project);
    } catch (err) {
      setEvalError(
        err instanceof Error ? err.message : 'No se pudo crear el guion de práctica.'
      );
    } finally {
      setSendingToPractice(false);
    }
  }

  async function handleEvaluate() {
    if (!text.trim()) {
      setEvalError('Escribe o pega primero el texto en inglés a evaluar.');
      return;
    }
    if (!audioBlob) {
      setEvalError('Sube un archivo de audio o graba tu voz antes de evaluar.');
      return;
    }

    setIsEvaluating(true);
    setEvalError(null);
    try {
      const wavChunks = await convertToAsrWavChunks(audioBlob, 110);
      const evaluation = await evaluateAudioApi({
        wavChunks,
        expectedText: cleanExpectedText(text),
        ignoreParentheses,
        saveHistory: true,
      });
      setResult(evaluation);
      const updatedHistory = await fetchEvaluations();
      setHistory(updatedHistory);
    } catch (err) {
      setEvalError(
        err instanceof Error
          ? err.message
          : 'No se pudo evaluar el audio. Verifica el formato o tu API key.'
      );
    } finally {
      setIsEvaluating(false);
    }
  }

  async function handleDeleteHistory(id: string) {
    await deleteEvaluationApi(id);
    setHistory((prev) => prev.filter((item) => item.id !== id));
    if (result?.id === id) setResult(null);
  }

  const resultComparison = useMemo(() => {
    if (!result) return null;
    const normTarget = normalizeCompareText(result.expectedText);
    if (!normTarget) return null;

    const priorMatches = history.filter(
      (item) =>
        item.id !== result.id &&
        item.createdAt < result.createdAt &&
        normalizeCompareText(item.expectedText) === normTarget
    );
    if (priorMatches.length === 0) return null;

    priorMatches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const previousMostRecent = priorMatches[0];
    const previousBestScore = Math.max(...priorMatches.map((m) => m.score));

    return compareEvaluations(result, previousMostRecent, {
      previousBestScore,
      previousLabel: 'tu evaluación anterior',
    });
  }, [result, history]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT: Text Input */}
        <div className="lg:col-span-7 rounded-2xl bg-white border border-slate-200 shadow-xs p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-extrabold text-slate-900">
                1. Texto en inglés de referencia
              </h2>
              <p className="text-xs text-slate-500">
                Pega cualquier texto que debas leer para compararlo con el audio.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setText(sofiaFullText)}
              className="rounded-xl bg-indigo-50 border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-100 cursor-pointer"
            >
              Cargar texto de Sofía
            </button>
          </div>

          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Pega aquí el texto en inglés..."
            className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm leading-relaxed text-slate-800 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={ignoreParentheses}
                onChange={(e) => setIgnoreParentheses(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600"
              />
              Ignorar indicaciones entre paréntesis (ej. <code>(Pausa breve)</code>)
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleListenText}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                <Volume2 className="w-3.5 h-3.5 text-indigo-600" />
                {isListeningText ? 'Detener voz' : 'Escuchar texto'}
              </button>

              <button
                type="button"
                onClick={handleGenerateGuide}
                disabled={loadingGuide || !text.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-bold text-indigo-800 hover:bg-indigo-100 disabled:opacity-50 cursor-pointer"
              >
                {loadingGuide ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                Guía fonética con IA
              </button>

              <button
                type="button"
                onClick={handleSendToPractice}
                disabled={sendingToPractice || !text.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
              >
                {sendingToPractice ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <BookOpen className="w-3.5 h-3.5" />
                )}
                Practicar por partes
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT: Audio Upload / Direct Record */}
        <div className="lg:col-span-5 rounded-2xl bg-white border border-slate-200 shadow-xs p-5 space-y-4">
          <div>
            <h2 className="text-lg font-extrabold text-slate-900">
              2. Sube o graba el audio
            </h2>
            <p className="text-xs text-slate-500">
              Acepta cualquier archivo (.mp3, .wav, .m4a, .ogg, .webm) o grabación directa.
            </p>
          </div>

          {/* Drag & Drop box */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFileSelected(e.dataTransfer.files?.[0]);
            }}
            onClick={() => fileInputRef.current?.click()}
            className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/80 hover:border-indigo-400 hover:bg-indigo-50/30 transition p-6 text-center cursor-pointer space-y-2"
          >
            <div className="w-11 h-11 rounded-xl bg-white border border-slate-200 shadow-xs flex items-center justify-center mx-auto text-indigo-600">
              <Upload className="w-5 h-5" />
            </div>
            <div className="text-sm font-bold text-slate-800">
              Haz clic o arrastra tu audio aquí
            </div>
            <div className="text-xs text-slate-500">
              La app lo convierte automáticamente al formato que entiende la IA
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                handleFileSelected(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>

          {/* Or record directly */}
          <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 border border-slate-200 p-3">
            {isRecording ? (
              <div className="flex items-center justify-between gap-3 w-full">
                <div className="flex items-center gap-2.5 flex-1">
                  <span className="w-3 h-3 rounded-full bg-rose-600 animate-ping" />
                  <div className="flex-1">
                    <div className="flex justify-between text-xs font-bold text-rose-700 mb-1">
                      <span>Grabando...</span>
                      <span className="font-mono">{formatTime(recElapsed)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-rose-200 overflow-hidden">
                      <div
                        className="h-full bg-rose-600 transition-all duration-75"
                        style={{ width: `${Math.max(8, Math.round(micLevel * 100))}%` }}
                      />
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleStopRecord}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-rose-700 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5 fill-current" /> Detener
                </button>
              </div>
            ) : (
              <>
                <span className="text-xs font-semibold text-slate-600">
                  ¿Prefieres grabar aquí?
                </span>
                <button
                  type="button"
                  onClick={handleStartRecord}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-rose-700 cursor-pointer"
                >
                  <Mic className="w-3.5 h-3.5" /> Grabar ahora
                </button>
              </>
            )}
          </div>

          {/* Loaded audio preview */}
          {audioPreviewUrl && (
            <div className="rounded-xl bg-indigo-50/70 border border-indigo-200 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-bold text-indigo-950 truncate flex items-center gap-1.5">
                  <FileAudio className="w-4 h-4 text-indigo-600 shrink-0" />
                  {audioLabel}
                </span>
                {audioDuration !== null && (
                  <span className="font-mono font-bold text-indigo-700 shrink-0">
                    {formatTime(audioDuration)}
                  </span>
                )}
              </div>
              <audio controls src={audioPreviewUrl} className="w-full h-9" />
            </div>
          )}

          {evalError && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2.5 text-xs text-rose-800 flex flex-wrap items-center justify-between gap-2">
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

          <button
            type="button"
            onClick={handleEvaluate}
            disabled={isEvaluating || !audioBlob || !text.trim()}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-extrabold text-white hover:bg-indigo-700 disabled:opacity-50 cursor-pointer shadow-sm"
          >
            {isEvaluating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Escuchando y evaluando pronunciación...
              </>
            ) : (
              <>
                <SearchCheck className="w-5 h-5" />
                Evaluar qué tan preciso es
              </>
            )}
          </button>
        </div>
      </div>

      {/* Phonetic preview generated by AI */}
      {phoneticPreview && (
        <div className="rounded-2xl bg-white border border-indigo-200 shadow-xs p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-extrabold text-indigo-950 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-600" />
              Guía fonética en español generada para este texto
            </h3>
            <button
              onClick={() => setPhoneticPreview(null)}
              className="text-xs font-bold text-slate-500 hover:text-slate-800 cursor-pointer"
            >
              Ocultar
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {phoneticPreview.segments.map((seg, i) => (
              <div
                key={seg.id}
                className="rounded-xl bg-slate-50 border border-slate-200 p-3 space-y-1"
              >
                <div className="text-xs font-bold text-indigo-700">Parte {i + 1}</div>
                <div className="text-sm font-bold text-slate-900">{seg.text}</div>
                {seg.phoneticEs && (
                  <div className="text-sm font-bold text-indigo-800">{seg.phoneticEs}</div>
                )}
                {seg.translationEs && (
                  <div className="text-xs text-slate-600">{seg.translationEs}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Evaluation Result */}
      {result && (
        <EvaluationCard
          result={result}
          voiceId={voiceId}
          comparison={resultComparison}
        />
      )}

      {/* Evaluation History */}
      {history.length > 0 && (
        <div className="rounded-2xl bg-white border border-slate-200 shadow-xs p-5 space-y-3">
          <h3 className="text-sm font-extrabold text-slate-800 flex items-center gap-2">
            <History className="w-4 h-4 text-indigo-600" />
            Historial de evaluaciones guardadas ({history.length})
          </h3>

          <div className="divide-y divide-slate-100">
            {history.map((item) => (
              <div
                key={item.id}
                className="py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 px-2 rounded-xl transition"
              >
                <button
                  type="button"
                  onClick={() => setResult(item)}
                  className="flex items-center gap-3 text-left flex-1 min-w-0 cursor-pointer"
                >
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-extrabold shrink-0 ${
                      item.score >= 85
                        ? 'bg-emerald-100 text-emerald-800'
                        : item.score >= 60
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-rose-100 text-rose-800'
                    }`}
                  >
                    {item.score}%
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-slate-800 truncate">
                      {item.expectedText}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {new Date(item.createdAt).toLocaleString()} · Precisión:{' '}
                      {item.wordAccuracy}%
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleDeleteHistory(item.id)}
                  className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg cursor-pointer"
                  title="Eliminar del historial"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
