import React, { useEffect, useState } from 'react';
import { Loader2, Sparkles, Volume2, X } from 'lucide-react';
import type { VoiceId, WordExplanation, WordGuide } from '../types';
import { explainWordApi } from '../lib/api';
import { speakEnglishText } from '../lib/ttsPlayer';

interface WordPopoverProps {
  word: string;
  contextSentence: string;
  localGuide?: WordGuide;
  voiceId: VoiceId;
  onClose: () => void;
}

export const WordPopover: React.FC<WordPopoverProps> = ({
  word,
  contextSentence,
  localGuide,
  voiceId,
  onClose,
}) => {
  const [loading, setLoading] = useState(false);
  const [explanation, setExplanation] = useState<WordExplanation | null>(null);
  const [speakingRate, setSpeakingRate] = useState<number | null>(null);

  useEffect(() => {
    let active = true;

    if (localGuide && localGuide.phoneticEs) {
      setExplanation({
        word: localGuide.word || word,
        phoneticEs: localGuide.phoneticEs,
        meaningEs: localGuide.meaningEs,
        tipEs: localGuide.tipEs || 'Escucha el audio despacio y repítela en voz alta.',
      });
      return;
    }

    setLoading(true);
    explainWordApi(word, contextSentence)
      .then((res) => {
        if (active) setExplanation(res);
      })
      .catch(() => {
        if (active) {
          setExplanation({
            word,
            phoneticEs: 'Escucha el botón de altavoz',
            meaningEs: 'No se pudo consultar el significado en este momento.',
            tipEs: 'Usa el botón lento para escuchar cada sonido con calma.',
          });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [word, contextSentence, localGuide]);

  const handleSpeak = async (rate: number) => {
    setSpeakingRate(rate);
    try {
      await speakEnglishText(word, { voiceId, rate });
    } finally {
      setSpeakingRate(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
              Guía de palabra
            </span>
            <h3 className="text-2xl font-extrabold text-slate-900 mt-0.5">{word}</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => handleSpeak(0.9)}
            disabled={speakingRate !== null}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 cursor-pointer"
          >
            <Volume2 className="w-4 h-4" />
            {speakingRate === 0.9 ? 'Sonando...' : 'Escuchar normal'}
          </button>
          <button
            onClick={() => handleSpeak(0.6)}
            disabled={speakingRate !== null}
            className="flex items-center gap-2 rounded-xl bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-200 disabled:opacity-60 cursor-pointer"
          >
            <Volume2 className="w-4 h-4" />
            {speakingRate === 0.6 ? 'Sonando...' : 'Muy lento (0.6x)'}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-6 justify-center text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
            Consultando cómo suena en español...
          </div>
        ) : (
          explanation && (
            <div className="space-y-3 rounded-xl bg-slate-50 p-4 border border-slate-200/80">
              <div>
                <div className="text-xs font-semibold text-slate-500">Léelo corrido así</div>
                <div className="text-2xl font-extrabold text-indigo-700 mt-0.5">
                  {explanation.phoneticEs || word}
                </div>
              </div>

              {explanation.meaningEs && (
                <div>
                  <div className="text-xs font-semibold text-slate-500">Qué significa</div>
                  <div className="text-sm font-medium text-slate-800 mt-0.5">
                    {explanation.meaningEs}
                  </div>
                </div>
              )}

              {explanation.tipEs && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-900 flex items-start gap-2">
                  <Sparkles className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>{explanation.tipEs}</span>
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
};
