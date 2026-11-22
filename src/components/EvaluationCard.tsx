import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Ear,
  Lightbulb,
  Minus,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Trophy,
  Volume2,
} from 'lucide-react';
import type { EvaluationResult, VoiceId } from '../types';
import type { EvaluationComparison } from '../lib/progressCompare';
import { speakEnglishText } from '../lib/ttsPlayer';

interface EvaluationCardProps {
  result: EvaluationResult;
  voiceId: VoiceId;
  compact?: boolean;
  comparison?: EvaluationComparison | null;
}

export const EvaluationCard: React.FC<EvaluationCardProps> = ({
  result,
  voiceId,
  compact = false,
  comparison = null,
}) => {
  const [playingWord, setPlayingWord] = useState<string | null>(null);

  const score = Math.max(0, Math.min(100, result.score));
  const strokeColor =
    score >= 85 ? '#10b981' : score >= 60 ? '#f59e0b' : '#f43f5e';
  const badgeBg =
    score >= 85
      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
      : score >= 60
      ? 'bg-amber-50 border-amber-200 text-amber-800'
      : 'bg-rose-50 border-rose-200 text-rose-800';

  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (score / 100) * circumference;

  const playWord = async (word: string) => {
    const clean = word.replace(/^[^a-zA-Z0-9'’]+|[^a-zA-Z0-9'’]+$/g, '');
    if (!clean) return;
    setPlayingWord(word);
    try {
      await speakEnglishText(clean, { voiceId, rate: 0.78 });
    } finally {
      setPlayingWord(null);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      {result.audioQuality && result.audioQuality.level !== 'good' && (
        <div
          className={`px-4 sm:px-5 py-3 border-b flex items-start gap-2 text-xs sm:text-sm font-semibold ${
            result.audioQuality.level === 'low'
              ? 'bg-amber-50/90 border-amber-200 text-amber-950'
              : 'bg-rose-50/90 border-rose-200 text-rose-950'
          }`}
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{result.audioQuality.message}</span>
        </div>
      )}

      {/* Progress comparison banner */}
      {comparison && (
        <div
          className={`px-4 sm:px-5 py-3 border-b space-y-2 ${
            comparison.delta > 0
              ? 'bg-emerald-50/90 border-emerald-200 text-emerald-950'
              : comparison.delta === 0
              ? 'bg-indigo-50/80 border-indigo-200 text-indigo-950'
              : 'bg-amber-50/90 border-amber-200 text-amber-950'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs sm:text-sm font-extrabold">
              {comparison.delta > 0 ? (
                <>
                  <TrendingUp className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>
                    ¡Sí mejoraste! +{comparison.delta}% respecto a {comparison.previousLabel} (
                    {comparison.previousScore}% → {comparison.currentScore}%)
                  </span>
                </>
              ) : comparison.delta === 0 ? (
                <>
                  <Minus className="w-4 h-4 text-indigo-600 shrink-0" />
                  <span>
                    Mantuviste el mismo puntaje ({comparison.currentScore}%) respecto a{' '}
                    {comparison.previousLabel}
                  </span>
                </>
              ) : (
                <>
                  <TrendingDown className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>
                    Bajó {Math.abs(comparison.delta)}% respecto a {comparison.previousLabel} (
                    {comparison.previousScore}% → {comparison.currentScore}%). Tu mejor marca
                    sigue siendo {comparison.previousBestScore}%.
                  </span>
                </>
              )}
            </div>

            {comparison.isNewBest && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-0.5 text-[11px] font-extrabold text-white shrink-0">
                <Trophy className="w-3 h-3" /> ¡Nueva mejor toma!
              </span>
            )}
          </div>

          {(comparison.improvedWords.length > 0 ||
            comparison.regressedWords.length > 0 ||
            comparison.stillNeedsWork.length > 0) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px]">
              {comparison.improvedWords.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-bold text-emerald-800">
                    ✅ Palabras que ya corregiste:
                  </span>
                  {comparison.improvedWords.map((w, i) => (
                    <span
                      key={`${w}-${i}`}
                      className="rounded-md bg-white border border-emerald-200 px-1.5 py-0.5 font-bold text-emerald-800"
                    >
                      {w}
                    </span>
                  ))}
                </div>
              )}

              {comparison.regressedWords.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-bold text-amber-800">
                    ⚠️ Palabras que antes salieron mejor:
                  </span>
                  {comparison.regressedWords.map((w, i) => (
                    <span
                      key={`${w}-${i}`}
                      className="rounded-md bg-white border border-amber-200 px-1.5 py-0.5 font-bold text-amber-900"
                    >
                      {w}
                    </span>
                  ))}
                </div>
              )}

              {comparison.stillNeedsWork.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-bold text-slate-700">🎯 Aún por practicar:</span>
                  {comparison.stillNeedsWork.map((w, i) => (
                    <span
                      key={`${w}-${i}`}
                      className="rounded-md bg-white border border-slate-200 px-1.5 py-0.5 font-semibold text-slate-700"
                    >
                      {w}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Header score summary */}
      <div className={`p-4 sm:p-5 border-b border-slate-200/80 flex flex-col sm:flex-row sm:items-center gap-4 ${badgeBg}`}>
        <div className="relative w-20 h-20 shrink-0 flex items-center justify-center bg-white rounded-full shadow-xs">
          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
            <circle
              cx="40"
              cy="40"
              r={radius}
              stroke="#e2e8f0"
              strokeWidth="7"
              fill="none"
            />
            <circle
              cx="40"
              cy="40"
              r={radius}
              stroke={strokeColor}
              strokeWidth="7"
              strokeLinecap="round"
              fill="none"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
            />
          </svg>
          <span className="absolute text-lg font-extrabold text-slate-900">{score}%</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-lg font-extrabold text-slate-900">
              {result.encouragingTitle}
            </h4>
          </div>
          <p className="text-sm text-slate-700 mt-1 leading-relaxed">{result.summary}</p>
          <div className="flex flex-wrap gap-2 mt-2.5 text-xs font-semibold">
            <span className="rounded-full bg-white/85 px-2.5 py-1 text-slate-700 border border-slate-200/80">
              Precisión: {result.wordAccuracy}%
            </span>
            <span className="rounded-full bg-white/85 px-2.5 py-1 text-slate-700 border border-slate-200/80">
              Palabras dichas: {result.completeness}%
            </span>
          </div>
        </div>
      </div>

      {/* Word by word heatmap */}
      <div className={compact ? 'p-4 space-y-4' : 'p-5 space-y-5'}>
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Palabra por palabra (haz clic en cualquiera para oír cómo suena)
            </span>
            <div className="flex items-center gap-3 text-[11px] font-medium text-slate-500">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Bien
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400" /> Cerca
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> Faltó / Revisar
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 rounded-xl bg-slate-50 p-3 border border-slate-200/80">
            {result.words.map((item, idx) => {
              let cls =
                'bg-emerald-100 text-emerald-900 border-emerald-200 hover:bg-emerald-200';
              if (item.status === 'close') {
                cls = 'bg-amber-100 text-amber-900 border-amber-300 hover:bg-amber-200';
              } else if (item.status === 'incorrect' || item.status === 'missing') {
                cls = 'bg-rose-100 text-rose-900 border-rose-300 hover:bg-rose-200';
              }
              const isPlaying = playingWord === item.expected;

              return (
                <button
                  key={`${item.expected}-${idx}`}
                  type="button"
                  onClick={() => playWord(item.expected)}
                  title={
                    item.status === 'correct'
                      ? '¡Bien pronunciada! Clic para escuchar'
                      : item.heard
                      ? `La IA escuchó: "${item.heard}" — Clic para oír la correcta`
                      : 'No se escuchó — Clic para oír cómo suena'
                  }
                  className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-sm font-semibold transition cursor-pointer ${cls} ${
                    isPlaying ? 'ring-2 ring-indigo-500' : ''
                  }`}
                >
                  <span>{item.expected}</span>
                  {item.status !== 'correct' && (
                    <Volume2 className="w-3 h-3 opacity-70" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* What AI heard */}
        <div className="rounded-xl bg-slate-50 border border-slate-200/80 p-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-600 mb-1">
            <Ear className="w-3.5 h-3.5 text-indigo-600" />
            Lo que escuchó la IA en tu audio:
          </div>
          <p className="text-sm text-slate-700 italic">
            {result.transcribedText ? `"${result.transcribedText}"` : '(No se detectó voz clara en el audio)'}
          </p>
        </div>

        {/* Specific word tips */}
        {result.wordFeedback && result.wordFeedback.length > 0 ? (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
              <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
              Palabras para practicar un poquito más
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {result.wordFeedback.map((wf, i) => (
                <div
                  key={`${wf.word}-${i}`}
                  className="rounded-xl border border-amber-200/90 bg-amber-50/60 p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900">{wf.word}</span>
                      {wf.phoneticEs && (
                        <span className="rounded-md bg-white px-2 py-0.5 text-xs font-bold text-indigo-700 border border-indigo-200">
                          {wf.phoneticEs}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => playWord(wf.word)}
                      className="rounded-lg bg-white p-1.5 text-indigo-600 border border-slate-200 hover:bg-indigo-50 cursor-pointer"
                      title="Escuchar palabra correcta"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="text-xs text-slate-500">
                    Sonó parecido a: <span className="font-medium text-slate-700">{wf.heard}</span>
                  </div>
                  <p className="text-xs text-slate-700 leading-relaxed">{wf.tipEs}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 flex items-center gap-2 text-sm text-emerald-900">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ¡Todas las palabras se escucharon claras y correctas!
          </div>
        )}

        {/* Next step */}
        {result.nextStepTip && (
          <div className="rounded-xl bg-indigo-50 border border-indigo-200 p-3 flex items-start gap-2.5 text-xs sm:text-sm text-indigo-950">
            <Lightbulb className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                Siguiente paso recomendado:
              </span>
              <span className="text-indigo-900">{result.nextStepTip}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
