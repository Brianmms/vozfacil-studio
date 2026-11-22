import type { VoiceId } from '../types';
import { requestTtsAudio } from './api';

const ttsUrlCache = new Map<string, string>();
let activeAudio: HTMLAudioElement | null = null;

export function stopAllSpeech(): void {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

export function speakSpanishText(text: string, rate = 0.95): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      resolve();
      return;
    }
    const clean = String(text || '').trim();
    if (!clean) {
      resolve();
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = 'es-MX';
    utterance.rate = Math.max(0.6, Math.min(1.2, rate));

    const voices = window.speechSynthesis.getVoices();
    const spanishVoice = voices.find((voice) =>
      voice.lang.toLowerCase().startsWith('es')
    );
    if (spanishVoice) utterance.voice = spanishVoice;

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();

    window.speechSynthesis.speak(utterance);
  });
}

function speakWithBrowserFallback(
  text: string,
  rate: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      reject(new Error('No hay motor de voz disponible en este navegador.'));
      return;
    }

    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    utter.rate = Math.max(0.5, Math.min(1.5, rate));

    const voices = window.speechSynthesis.getVoices();
    const enVoice =
      voices.find((v) => v.lang.startsWith('en-US') && /natural|google|zira|aria|jenny/i.test(v.name)) ||
      voices.find((v) => v.lang.startsWith('en'));
    if (enVoice) utter.voice = enVoice;

    const onAbort = () => {
      window.speechSynthesis.cancel();
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    utter.onend = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    utter.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };

    window.speechSynthesis.speak(utter);
  });
}

function playAudioUrl(url: string, rate: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    stopAllSpeech();
    const audio = new Audio(url);
    audio.playbackRate = rate;
    audio.preservesPitch = true;
    activeAudio = audio;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (activeAudio === audio) activeAudio = null;
    };

    const onAbort = () => {
      audio.pause();
      cleanup();
      resolve();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    audio.onended = () => {
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('Error reproduciendo el audio guía.'));
    };

    audio.play().catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

export async function speakEnglishText(
  text: string,
  options: {
    voiceId?: VoiceId;
    rate?: number;
    signal?: AbortSignal;
  } = {}
): Promise<{ usedFallback: boolean }> {
  const clean = text.trim();
  if (!clean) return { usedFallback: false };

  const voiceId = options.voiceId || 'stella';
  const rate = options.rate ?? 1;
  const cacheKey = `${voiceId}::${clean}`;

  let objectUrl = ttsUrlCache.get(cacheKey);
  if (!objectUrl) {
    try {
      const wavBlob = await requestTtsAudio(clean, voiceId);
      objectUrl = URL.createObjectURL(wavBlob);
      ttsUrlCache.set(cacheKey, objectUrl);
    } catch {
      await speakWithBrowserFallback(clean, rate, options.signal);
      return { usedFallback: true };
    }
  }

  try {
    await playAudioUrl(objectUrl, rate, options.signal);
    return { usedFallback: false };
  } catch {
    await speakWithBrowserFallback(clean, rate, options.signal);
    return { usedFallback: true };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export async function playWordByWord(
  words: string[],
  options: {
    voiceId?: VoiceId;
    rate?: number;
    pauseMs?: number;
    onWordIndex?: (index: number | null) => void;
    signal?: AbortSignal;
  } = {}
): Promise<{ usedFallback: boolean }> {
  const { voiceId = 'stella', rate = 0.85, pauseMs = 280, onWordIndex, signal } = options;
  let usedFallback = false;

  for (let i = 0; i < words.length; i++) {
    if (signal?.aborted) break;
    const raw = words[i];
    const spoken = raw.replace(/^[^a-zA-Z0-9'’]+|[^a-zA-Z0-9'’]+$/g, '');
    if (!spoken) continue;

    onWordIndex?.(i);
    const res = await speakEnglishText(spoken, { voiceId, rate, signal });
    if (res.usedFallback) usedFallback = true;
    if (signal?.aborted) break;
    await sleep(pauseMs, signal);
  }

  onWordIndex?.(null);
  return { usedFallback };
}
