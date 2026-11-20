import { Mp3Encoder } from '@breezystack/lamejs';
import type { StitchedRender, StudioClip, TimelineOffset } from '../types';
import {
  encodeWav16Bit,
  extractPeaksFromFloat32,
  extractSamplesWithCuts,
  fetchAudioBuffer,
  getAudioContext,
  getKeptRanges,
  resampleBufferMono,
} from './audioUtils';

export interface StitchOptions {
  normalize: boolean;
  fadeMs: number;
  targetSampleRate?: number;
}

export async function renderStitchedAudio(
  clips: StudioClip[],
  options: StitchOptions
): Promise<StitchedRender> {
  const { normalize = true, fadeMs = 15, targetSampleRate = 44100 } = options;
  if (clips.length === 0) {
    throw new Error('Agrega al menos un clip de audio para unir.');
  }

  const processedPieces: Array<{
    clip: StudioClip;
    samples: Float32Array;
    pauseSamples: number;
  }> = [];

  for (let idx = 0; idx < clips.length; idx++) {
    const clip = clips[idx];
    const buffer = await fetchAudioBuffer(clip.audioUrl);
    const mono = await resampleBufferMono(buffer, targetSampleRate);

    const keptRanges = getKeptRanges(clip.trimStart, clip.trimEnd, clip.cuts);
    const { samples: trimmed } = extractSamplesWithCuts(
      mono,
      targetSampleRate,
      keptRanges,
      fadeMs > 0 ? 12 : 0
    );

    if (trimmed.length === 0) continue;

    // Measure RMS and peak
    let sumSq = 0;
    let maxAbs = 0.0001;
    for (let i = 0; i < trimmed.length; i++) {
      const v = trimmed[i];
      sumSq += v * v;
      const abs = Math.abs(v);
      if (abs > maxAbs) maxAbs = abs;
    }
    const rms = Math.sqrt(sumSq / trimmed.length);

    let gainFactor = clip.gain;
    if (normalize && rms > 0.004) {
      const targetRms = 0.16;
      const normGain = Math.min(6, targetRms / rms);
      gainFactor *= normGain;
    }

    // Prevent harsh clipping while keeping natural loudness
    const maxAllowedGain = 0.92 / maxAbs;
    const effectiveGain = Math.min(gainFactor, maxAllowedGain);

    for (let i = 0; i < trimmed.length; i++) {
      trimmed[i] = trimmed[i] * effectiveGain;
    }

    // Apply smooth fade-in / fade-out to eliminate clicks at cuts
    const fadeSamples = Math.min(
      Math.floor(trimmed.length / 4),
      Math.floor((fadeMs / 1000) * targetSampleRate)
    );
    if (fadeSamples > 0) {
      for (let i = 0; i < fadeSamples; i++) {
        const ramp = i / fadeSamples;
        trimmed[i] *= ramp;
        trimmed[trimmed.length - 1 - i] *= ramp;
      }
    }

    const isLast = idx === clips.length - 1;
    const pauseSamples = isLast ? 0 : Math.max(0, Math.round(clip.pauseAfterSec * targetSampleRate));

    processedPieces.push({ clip, samples: trimmed, pauseSamples });
  }

  if (processedPieces.length === 0) {
    throw new Error('Los clips seleccionados no contienen audio válido.');
  }

  const totalSamples = processedPieces.reduce(
    (acc, item) => acc + item.samples.length + item.pauseSamples,
    0
  );

  const output = new Float32Array(totalSamples);
  const timelineOffsets: TimelineOffset[] = [];
  let cursor = 0;

  for (const item of processedPieces) {
    const startSec = cursor / targetSampleRate;
    output.set(item.samples, cursor);
    cursor += item.samples.length;
    const endSec = cursor / targetSampleRate;

    timelineOffsets.push({
      clipId: item.clip.id,
      title: item.clip.title,
      startSec,
      endSec,
    });

    cursor += item.pauseSamples;
  }

  const ctx = getAudioContext();
  const audioBuffer = ctx.createBuffer(1, output.length, targetSampleRate);
  audioBuffer.copyToChannel(output, 0);

  const wavBlob = encodeWav16Bit(output, targetSampleRate);
  const durationSec = output.length / targetSampleRate;
  const peaks = extractPeaksFromFloat32(output, 140);

  return {
    audioBuffer,
    wavBlob,
    durationSec,
    peaks,
    timelineOffsets,
  };
}

export function encodeAudioBufferToMp3(audioBuffer: AudioBuffer, kbps = 128): Blob {
  const sampleRate = audioBuffer.sampleRate;
  const samplesFloat = audioBuffer.getChannelData(0);
  const int16 = new Int16Array(samplesFloat.length);

  for (let i = 0; i < samplesFloat.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samplesFloat[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const blockSize = 1152;
  const mp3Data: BlobPart[] = [];

  for (let i = 0; i < int16.length; i += blockSize) {
    const chunk = int16.subarray(i, i + blockSize);
    const encoded = encoder.encodeBuffer(chunk);
    if (encoded.length > 0) {
      mp3Data.push(new Uint8Array(encoded));
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) {
    mp3Data.push(new Uint8Array(flushed));
  }

  return new Blob(mp3Data, { type: 'audio/mp3' });
}
