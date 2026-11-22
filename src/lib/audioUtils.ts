import type { AudioCutRange, AudioQuality } from '../types';
import { loadAudioBlobFromUrl } from './localStore';

let sharedCtx: AudioContext | null = null;
const audioBufferCache = new Map<string, AudioBuffer>();

export function evictAudioBufferCache(url: string): void {
  audioBufferCache.delete(url);
}

export function getAudioContext(): AudioContext {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new Ctx();
  }
  if (sharedCtx.state === 'suspended') {
    sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

export async function ensureAudioContextRunning(): Promise<AudioContext> {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  return ctx;
}

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

export function tryParsePcmWavToAudioBuffer(
  arrayBuffer: ArrayBuffer,
  ctx: AudioContext
): AudioBuffer | null {
  if (arrayBuffer.byteLength < 44) return null;
  const view = new DataView(arrayBuffer);
  if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WAVE') {
    return null;
  }

  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataBytes = 0;

  let offset = 12;
  while (offset + 8 <= arrayBuffer.byteLength) {
    const chunkId = readFourCC(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ' && chunkDataStart + 16 <= arrayBuffer.byteLength) {
      audioFormat = view.getUint16(chunkDataStart, true);
      numChannels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitsPerSample = view.getUint16(chunkDataStart + 14, true);
      if (audioFormat === 0xfffe && chunkSize >= 40 && chunkDataStart + 26 <= arrayBuffer.byteLength) {
        audioFormat = view.getUint16(chunkDataStart + 24, true);
      }
    } else if (chunkId === 'data') {
      dataStart = chunkDataStart;
      const available = arrayBuffer.byteLength - dataStart;
      dataBytes =
        chunkSize === 0xffffffff || chunkSize > available ? available : chunkSize;
      break;
    }

    if (chunkSize === 0xffffffff || chunkDataStart + chunkSize > arrayBuffer.byteLength) {
      break;
    }
    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (
    dataStart < 0 ||
    dataBytes <= 0 ||
    numChannels < 1 ||
    numChannels > 8 ||
    sampleRate < 3000 ||
    sampleRate > 192000
  ) {
    return null;
  }

  const isPcm = audioFormat === 1 && (bitsPerSample === 8 || bitsPerSample === 16 || bitsPerSample === 24 || bitsPerSample === 32);
  const isFloat = audioFormat === 3 && bitsPerSample === 32;
  if (!isPcm && !isFloat) {
    return null;
  }

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const frameCount = Math.floor(dataBytes / blockAlign);
  if (frameCount <= 0) return null;

  const audioBuffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  const channelArrays: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channelArrays.push(audioBuffer.getChannelData(ch));
  }

  for (let i = 0; i < frameCount; i++) {
    const frameOffset = dataStart + i * blockAlign;
    for (let ch = 0; ch < numChannels; ch++) {
      const p = frameOffset + ch * bytesPerSample;
      let sample = 0;
      if (isFloat) {
        sample = view.getFloat32(p, true);
      } else if (bitsPerSample === 16) {
        sample = view.getInt16(p, true) / 32768;
      } else if (bitsPerSample === 8) {
        sample = (view.getUint8(p) - 128) / 128;
      } else if (bitsPerSample === 24) {
        const b0 = view.getUint8(p);
        const b1 = view.getUint8(p + 1);
        const b2 = view.getUint8(p + 2);
        let val = b0 | (b1 << 8) | (b2 << 16);
        if (val & 0x800000) val |= ~0xffffff;
        sample = val / 8388608;
      } else {
        sample = view.getInt32(p, true) / 2147483648;
      }
      channelArrays[ch][i] = sample;
    }
  }

  return audioBuffer;
}

export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error('El archivo de audio está vacío.');
  }
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => {});
  }

  const parsedWav = tryParsePcmWavToAudioBuffer(arrayBuffer, ctx);
  if (parsedWav) {
    return parsedWav;
  }

  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'formato no compatible';
    throw new Error(
      `No se pudo decodificar este audio (${detail}). Intenta grabarlo de nuevo o usa un archivo MP3/WAV válido.`
    );
  }
}

export async function fetchAudioBuffer(
  url: string,
  bypassCache = false
): Promise<AudioBuffer> {
  if (!bypassCache && audioBufferCache.has(url)) {
    return audioBufferCache.get(url)!;
  }
  const blob = await loadAudioBlobFromUrl(url);
  const decoded = await decodeAudioBlob(blob);
  if (audioBufferCache.size >= 60) {
    const oldestKey = audioBufferCache.keys().next().value;
    if (oldestKey) audioBufferCache.delete(oldestKey);
  }
  audioBufferCache.set(url, decoded);
  return decoded;
}

export function mixToMono(audioBuffer: AudioBuffer): Float32Array {
  const length = audioBuffer.length;
  const numChannels = audioBuffer.numberOfChannels;
  if (numChannels === 1) {
    return new Float32Array(audioBuffer.getChannelData(0));
  }
  const out = new Float32Array(length);
  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      out[i] += data[i] / numChannels;
    }
  }
  return out;
}

export async function analyzeAudioQuality(blob: Blob): Promise<AudioQuality> {
  try {
    const buffer = await decodeAudioBlob(blob);
    const mono = mixToMono(buffer);
    const length = mono.length;
    if (length === 0) {
      return {
        level: 'low',
        rmsDb: -100,
        peakDb: -100,
        message: 'El audio está vacío. Graba de nuevo.',
      };
    }

    const frameSize = Math.max(256, Math.round(buffer.sampleRate * 0.05));
    const frameRms: number[] = [];
    let peak = 0;
    let clippedSamples = 0;

    for (let start = 0; start < length; start += frameSize) {
      const end = Math.min(length, start + frameSize);
      let sumSq = 0;
      for (let i = start; i < end; i++) {
        const value = mono[i];
        sumSq += value * value;
        const abs = Math.abs(value);
        if (abs > peak) peak = abs;
        if (abs >= 0.99) clippedSamples += 1;
      }
      frameRms.push(Math.sqrt(sumSq / Math.max(1, end - start)));
    }

    const sorted = [...frameRms].sort((a, b) => a - b);
    const percentile = (p: number) => {
      if (sorted.length === 0) return 0;
      const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.round(p * (sorted.length - 1)))
      );
      return sorted[index];
    };

    const toDb = (value: number) => (value > 0 ? 20 * Math.log10(value) : -100);
    // 10th percentile ~= background noise floor
    const noiseDb = toDb(percentile(0.1));
    // Average loudness of frames that actually contain voice (ignores silence)
    const activeFrames = frameRms.filter((value) => toDb(value) > noiseDb + 6);
    const speechLevel =
      activeFrames.length > 0
        ? activeFrames.reduce((acc, value) => acc + value, 0) / activeFrames.length
        : percentile(0.9);
    const speechDb = toDb(speechLevel);
    const snr = speechDb - noiseDb;
    const peakDb = toDb(peak);
    const clippingRatio = clippedSamples / length;

    const rmsDb = Number(speechDb.toFixed(1));
    const roundedPeak = Number(peakDb.toFixed(1));

    if (clippingRatio >= 0.002) {
      return {
        level: 'clipping',
        rmsDb,
        peakDb: roundedPeak,
        message:
          'El audio se escucha saturado/distorsionado. Baja el volumen del micrófono o aléjate un poco.',
      };
    }
    if (speechDb <= -32) {
      return {
        level: 'low',
        rmsDb,
        peakDb: roundedPeak,
        message:
          'Se escucha muy lejos o bajito. Acércate al micrófono y habla un poco más fuerte.',
      };
    }
    if (snr < 12) {
      return {
        level: 'noisy',
        rmsDb,
        peakDb: roundedPeak,
        message:
          'Se oye poco claro o con ruido de fondo (como lejos). Acércate al micrófono y busca un lugar más silencioso.',
      };
    }
    if (speechDb >= -5) {
      return {
        level: 'clipping',
        rmsDb,
        peakDb: roundedPeak,
        message:
          'Se escucha muy fuerte y puede saturarse. Aléjate un poco del micrófono.',
      };
    }
    return {
      level: 'good',
      rmsDb,
      peakDb: roundedPeak,
      message: 'Buen nivel de audio.',
    };
  } catch {
    return {
      level: 'good',
      rmsDb: 0,
      peakDb: 0,
      message: 'No se pudo analizar la calidad del audio.',
    };
  }
}

export function encodeWav16Bit(samples: Float32Array, sampleRate: number): Blob {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // Linear PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export async function resampleBufferMono(
  audioBuffer: AudioBuffer,
  targetSampleRate: number
): Promise<Float32Array> {
  if (audioBuffer.sampleRate === targetSampleRate) {
    return mixToMono(audioBuffer);
  }
  const targetLength = Math.max(1, Math.ceil(audioBuffer.duration * targetSampleRate));
  const offline = new OfflineAudioContext(1, targetLength, targetSampleRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

export async function convertBlobToCleanWav(
  blob: Blob,
  targetSampleRate = 44100
): Promise<{ wavBlob: Blob; durationSec: number; peaks: number[] }> {
  const decoded = await decodeAudioBlob(blob);
  const mono = await resampleBufferMono(decoded, targetSampleRate);
  const wavBlob = encodeWav16Bit(mono, targetSampleRate);
  const peaks = extractPeaksFromFloat32(mono, 72);
  return {
    wavBlob,
    durationSec: decoded.duration,
    peaks,
  };
}

export async function convertToAsrWavChunks(
  blob: Blob,
  maxChunkSec = 110
): Promise<Blob[]> {
  const decoded = await decodeAudioBlob(blob);
  const targetSampleRate = 16000;
  const mono16k = await resampleBufferMono(decoded, targetSampleRate);

  const maxSamplesPerChunk = maxChunkSec * targetSampleRate;
  const chunks: Blob[] = [];

  for (let start = 0; start < mono16k.length; start += maxSamplesPerChunk) {
    const end = Math.min(mono16k.length, start + maxSamplesPerChunk);
    const slice = mono16k.subarray(start, end);
    if (slice.length > 0) {
      chunks.push(encodeWav16Bit(slice, targetSampleRate));
    }
  }

  if (chunks.length === 0) {
    chunks.push(encodeWav16Bit(new Float32Array(1600), targetSampleRate));
  }
  return chunks;
}

export function extractPeaksFromFloat32(samples: Float32Array, numBars = 80): number[] {
  if (samples.length === 0) return new Array(numBars).fill(0.05);
  const blockSize = Math.max(1, Math.floor(samples.length / numBars));
  const peaks: number[] = [];
  let maxPeak = 0.001;

  for (let i = 0; i < numBars; i++) {
    const start = i * blockSize;
    const end = Math.min(samples.length, start + blockSize);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(samples[j]);
      if (abs > peak) peak = abs;
    }
    if (peak > maxPeak) maxPeak = peak;
    peaks.push(peak);
  }

  return peaks.map((p) => Number(Math.max(0.04, p / maxPeak).toFixed(3)));
}

export function extractWaveformPeaks(audioBuffer: AudioBuffer, numBars = 80): number[] {
  return extractPeaksFromFloat32(mixToMono(audioBuffer), numBars);
}

export function detectSilenceBounds(
  audioBuffer: AudioBuffer,
  threshold = 0.015,
  padSec = 0.08
): { trimStart: number; trimEnd: number } {
  const samples = mixToMono(audioBuffer);
  const sr = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;
  if (duration <= 0.35 || samples.length === 0) {
    return { trimStart: 0, trimEnd: Number(duration.toFixed(2)) };
  }

  let firstActive = -1;
  let lastActive = -1;

  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) {
      firstActive = i;
      break;
    }
  }

  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i]) >= threshold) {
      lastActive = i;
      break;
    }
  }

  if (firstActive === -1 || lastActive === -1 || firstActive >= lastActive) {
    return { trimStart: 0, trimEnd: Number(duration.toFixed(2)) };
  }

  const trimStart = Math.max(0, firstActive / sr - padSec);
  const trimEnd = Math.min(duration, lastActive / sr + padSec);

  if (trimEnd - trimStart < 0.25) {
    return { trimStart: 0, trimEnd: Number(duration.toFixed(2)) };
  }

  return {
    trimStart: Number(trimStart.toFixed(2)),
    trimEnd: Number(trimEnd.toFixed(2)),
  };
}

export function mergeCutRanges(
  cuts: AudioCutRange[],
  minBound: number,
  maxBound: number
): AudioCutRange[] {
  if (!Array.isArray(cuts) || cuts.length === 0 || maxBound <= minBound) {
    return [];
  }
  const normalized = cuts
    .map((c) => ({
      start: Number(Math.max(minBound, Math.min(maxBound, c.start)).toFixed(2)),
      end: Number(Math.max(minBound, Math.min(maxBound, c.end)).toFixed(2)),
    }))
    .filter((c) => c.end - c.start >= 0.03)
    .sort((a, b) => a.start - b.start);

  const merged: AudioCutRange[] = [];
  for (const item of normalized) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end + 0.02) {
      last.end = Math.max(last.end, item.end);
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

export function getKeptRanges(
  trimStart: number,
  trimEnd: number,
  cuts: AudioCutRange[] = []
): AudioCutRange[] {
  const safeStart = Math.max(0, trimStart);
  const safeEnd = Math.max(safeStart, trimEnd);
  if (safeEnd - safeStart < 0.03) return [];

  const mergedCuts = mergeCutRanges(cuts, safeStart, safeEnd);
  const kept: AudioCutRange[] = [];
  let cursor = safeStart;

  for (const cut of mergedCuts) {
    if (cut.start - cursor >= 0.03) {
      kept.push({
        start: Number(cursor.toFixed(3)),
        end: Number(cut.start.toFixed(3)),
      });
    }
    cursor = Math.max(cursor, cut.end);
  }

  if (safeEnd - cursor >= 0.03) {
    kept.push({
      start: Number(cursor.toFixed(3)),
      end: Number(safeEnd.toFixed(3)),
    });
  }

  return kept;
}

export function getEffectiveClipDuration(
  trimStart: number,
  trimEnd: number,
  cuts: AudioCutRange[] = []
): number {
  const kept = getKeptRanges(trimStart, trimEnd, cuts);
  const total = kept.reduce((acc, r) => acc + Math.max(0, r.end - r.start), 0);
  return Number(total.toFixed(2));
}

export interface CutSegmentMapItem {
  outStart: number;
  outEnd: number;
  srcStart: number;
  srcEnd: number;
}

export function extractSamplesWithCuts(
  mono: Float32Array,
  sampleRate: number,
  keptRanges: AudioCutRange[],
  crossfadeMs = 12
): { samples: Float32Array; segmentMap: CutSegmentMapItem[] } {
  const slices: Array<{ data: Float32Array; srcStart: number; srcEnd: number }> = [];
  const cfSamplesMax = Math.max(0, Math.floor((crossfadeMs / 1000) * sampleRate));

  for (const r of keptRanges) {
    const startIdx = Math.max(0, Math.floor(r.start * sampleRate));
    const endIdx = Math.min(mono.length, Math.floor(r.end * sampleRate));
    if (endIdx <= startIdx) continue;
    const copy = new Float32Array(mono.subarray(startIdx, endIdx));
    slices.push({
      data: copy,
      srcStart: startIdx / sampleRate,
      srcEnd: endIdx / sampleRate,
    });
  }

  if (slices.length === 0) {
    return { samples: new Float32Array(0), segmentMap: [] };
  }

  // Smooth splice transitions at internal cut boundaries
  if (slices.length > 1 && cfSamplesMax > 0) {
    for (let idx = 0; idx < slices.length; idx++) {
      const piece = slices[idx].data;
      const cf = Math.min(Math.floor(piece.length / 4), cfSamplesMax);
      if (cf <= 0) continue;
      if (idx > 0) {
        for (let i = 0; i < cf; i++) {
          piece[i] *= i / cf;
        }
      }
      if (idx < slices.length - 1) {
        for (let i = 0; i < cf; i++) {
          piece[piece.length - 1 - i] *= i / cf;
        }
      }
    }
  }

  const totalLen = slices.reduce((acc, s) => acc + s.data.length, 0);
  const out = new Float32Array(totalLen);
  const segmentMap: CutSegmentMapItem[] = [];
  let cursor = 0;

  for (const s of slices) {
    out.set(s.data, cursor);
    segmentMap.push({
      outStart: cursor / sampleRate,
      outEnd: (cursor + s.data.length) / sampleRate,
      srcStart: s.srcStart,
      srcEnd: s.srcEnd,
    });
    cursor += s.data.length;
  }

  return { samples: out, segmentMap };
}

export function mapOutputTimeToSourceTime(
  outSec: number,
  segmentMap: CutSegmentMapItem[]
): number {
  if (segmentMap.length === 0) return 0;
  for (const seg of segmentMap) {
    if (outSec >= seg.outStart && outSec <= seg.outEnd) {
      return Math.min(seg.srcEnd, seg.srcStart + (outSec - seg.outStart));
    }
  }
  const last = segmentMap[segmentMap.length - 1];
  return last.srcEnd;
}

export function detectInternalSilences(
  audioBuffer: AudioBuffer,
  options: {
    threshold?: number;
    minSilenceSec?: number;
    keepBreathSec?: number;
    padEdgeSec?: number;
  } = {}
): { trimStart: number; trimEnd: number; cuts: AudioCutRange[] } {
  const {
    threshold = 0.014,
    minSilenceSec = 0.55,
    keepBreathSec = 0.14,
    padEdgeSec = 0.08,
  } = options;

  const { trimStart, trimEnd } = detectSilenceBounds(
    audioBuffer,
    threshold,
    padEdgeSec
  );

  const samples = mixToMono(audioBuffer);
  const sr = audioBuffer.sampleRate;
  const startIdx = Math.max(0, Math.floor(trimStart * sr));
  const endIdx = Math.min(samples.length, Math.floor(trimEnd * sr));
  const winSize = Math.max(1, Math.floor(sr * 0.02));
  const rmsThreshold = threshold * 0.85;

  const rawCuts: AudioCutRange[] = [];
  let silenceStartIdx: number | null = null;

  for (let pos = startIdx; pos < endIdx; pos += winSize) {
    const winEnd = Math.min(endIdx, pos + winSize);
    let sumSq = 0;
    for (let j = pos; j < winEnd; j++) {
      sumSq += samples[j] * samples[j];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, winEnd - pos));

    if (rms < rmsThreshold) {
      if (silenceStartIdx === null) silenceStartIdx = pos;
    } else if (silenceStartIdx !== null) {
      const runStartSec = silenceStartIdx / sr;
      const runEndSec = pos / sr;
      if (runEndSec - runStartSec >= minSilenceSec) {
        const halfBreath = keepBreathSec / 2;
        const cutStart = Number((runStartSec + halfBreath).toFixed(2));
        const cutEnd = Number((runEndSec - halfBreath).toFixed(2));
        if (cutEnd - cutStart >= 0.15) {
          rawCuts.push({ start: cutStart, end: cutEnd });
        }
      }
      silenceStartIdx = null;
    }
  }

  return {
    trimStart,
    trimEnd,
    cuts: mergeCutRanges(rawCuts, trimStart, trimEnd),
  };
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatTimePrecise(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0.00s';
  return `${seconds.toFixed(2)}s`;
}
