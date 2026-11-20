import { encodeWav16Bit, extractPeaksFromFloat32 } from './audioUtils';

function micErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Permiso de micrófono denegado. Toca el candado del navegador, permite el micrófono y vuelve a intentar.';
  }
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'OverconstrainedError'
  ) {
    return 'No se encontró un micrófono. Conecta uno, actívalo en el sistema (Privacidad → Micrófono) y vuelve a intentar.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'El micrófono está en uso o bloqueado por otra app. Ciérrala o reinicia el navegador e intenta de nuevo.';
  }
  return 'No se pudo acceder al micrófono. Revisa que esté conectado y permitido en el navegador.';
}

export interface RecordedAudioResult {
  blob: Blob;
  durationSec: number;
  peaks: number[];
  sampleRate: number;
}

export class PcmAudioRecorder {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private startTime = 0;
  private rafId: number | null = null;
  private sampleRate = 44100;

  async start(onLevel?: (level: number, elapsedSec: number) => void): Promise<void> {
    if (!window.isSecureContext) {
      throw new Error(
        'El micrófono requiere una conexión segura (https://). Si entras desde otro dispositivo, abre la dirección https://... y acepta el certificado local.'
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Tu navegador no soporta grabación de micrófono.');
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw new Error(micErrorMessage(error));
    }

    if (!this.stream) {
      throw new Error('No se encontró un micrófono conectado.');
    }

    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new Ctx();
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
    this.sampleRate = this.audioCtx.sampleRate;

    this.chunks = [];
    this.totalSamples = 0;
    this.startTime = performance.now();

    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;

    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.silentGain = this.audioCtx.createGain();
    this.silentGain.gain.value = 0;

    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.chunks.push(copy);
      this.totalSamples += copy.length;
    };

    this.source.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioCtx.destination);

    if (onLevel) {
      const freqData = new Uint8Array(this.analyser.frequencyBinCount);
      const tick = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(freqData);
        let sumSq = 0;
        for (let i = 0; i < freqData.length; i++) {
          const v = (freqData[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.min(1, Math.sqrt(sumSq / freqData.length) * 3.2);
        const elapsedSec = (performance.now() - this.startTime) / 1000;
        onLevel(rms, elapsedSec);
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    }
  }

  async stop(): Promise<RecordedAudioResult> {
    const sampleRate = this.sampleRate;
    const merged = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    await this.cleanup();

    if (merged.length < Math.floor(sampleRate * 0.12)) {
      throw new Error(
        'No se capturó sonido del micrófono (grabación demasiado corta o micrófono inactivo). Habla al menos 1 segundo e intenta de nuevo.'
      );
    }

    const durationSec = Number((merged.length / sampleRate).toFixed(2));
    const blob = encodeWav16Bit(merged, sampleRate);
    const peaks = extractPeaksFromFloat32(merged, 72);

    return {
      blob,
      durationSec,
      peaks,
      sampleRate,
    };
  }

  async cancel(): Promise<void> {
    this.chunks = [];
    this.totalSamples = 0;
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    try {
      this.processor?.disconnect();
      this.analyser?.disconnect();
      this.source?.disconnect();
      this.silentGain?.disconnect();
    } catch {
      // Ignore already-disconnected nodes
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      try {
        await this.audioCtx.close();
      } catch {
        // Ignore close errors
      }
    }
    this.audioCtx = null;
    this.processor = null;
    this.analyser = null;
    this.source = null;
    this.silentGain = null;
  }
}
