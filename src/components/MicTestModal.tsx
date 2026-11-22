import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, RefreshCw, X } from 'lucide-react';

interface MicTestModalProps {
  open: boolean;
  onClose: () => void;
}

function micTestError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Permiso de micrófono denegado. Permite el micrófono en el navegador y vuelve a intentar.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No se encontró un micrófono. Conecta uno y vuelve a intentar.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'El micrófono está en uso por otra app. Ciérrala e intenta de nuevo.';
  }
  return 'No se pudo abrir el micrófono.';
}

export const MicTestModal: React.FC<MicTestModalProps> = ({ open, onClose }) => {
  const [starting, setStarting] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [levelDb, setLevelDb] = useState(-100);
  const [peakDb, setPeakDb] = useState(-100);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      ctxRef.current.close().catch(() => {});
    }
    ctxRef.current = null;
  }, []);

  const start = useCallback(
    async (id?: string) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Tu navegador no soporta acceso al micrófono.');
        return;
      }
      setStarting(true);
      setError(null);
      stop();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: id ? { deviceId: { exact: id } } : true,
        });
        streamRef.current = stream;

        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctx();
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        ctxRef.current = ctx;

        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);

        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sumSq = 0;
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const value = (data[i] - 128) / 128;
            sumSq += value * value;
            const abs = Math.abs(value);
            if (abs > peak) peak = abs;
          }
          const rms = Math.sqrt(sumSq / data.length);
          setLevelDb(rms > 0 ? 20 * Math.log10(rms) : -100);
          setPeakDb(peak > 0 ? 20 * Math.log10(peak) : -100);
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();

        const all = await navigator.mediaDevices.enumerateDevices();
        const inputs = all.filter((device) => device.kind === 'audioinput');
        setDevices(inputs);
        const currentId =
          id || stream.getAudioTracks()[0]?.getSettings().deviceId || '';
        if (currentId) setDeviceId(currentId);
      } catch (err) {
        setError(micTestError(err));
      } finally {
        setStarting(false);
      }
    },
    [stop]
  );

  useEffect(() => {
    if (open) {
      start(deviceId || undefined);
    } else {
      stop();
    }
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const status =
    levelDb <= -40
      ? { label: 'Muy bajito / se escucha lejos', tone: 'bg-amber-50 border-amber-200 text-amber-900' }
      : levelDb >= -6
      ? { label: 'Muy fuerte (puede saturar)', tone: 'bg-rose-50 border-rose-200 text-rose-900' }
      : { label: 'Buen nivel', tone: 'bg-emerald-50 border-emerald-200 text-emerald-900' };

  const meterWidth = Math.max(4, Math.min(100, ((levelDb + 60) / 60) * 100));

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-900/45 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
              <Mic className="w-5 h-5 text-indigo-600" />
              Probar micrófono
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Habla normal y mira el nivel. Si está muy bajo, acércate o sube el volumen de
              entrada del sistema.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error ? (
          <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2.5 text-xs text-rose-800">
            {error}
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className={`rounded-xl border px-3 py-2 text-xs font-bold ${status.tone}`}>
                {status.label}
              </div>
              <div className="h-4 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500 transition-all duration-75"
                  style={{ width: `${meterWidth}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] font-mono text-slate-500">
                <span>Nivel: {levelDb.toFixed(0)} dB</span>
                <span>Pico: {peakDb.toFixed(0)} dB</span>
              </div>
            </div>

            {devices.length > 1 && (
              <label className="block text-xs font-bold text-slate-600">
                Micrófono
                <select
                  value={deviceId}
                  onChange={(e) => start(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  {devices.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || `Micrófono ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs text-slate-600 space-y-1">
              <p>
                <strong>Si se escucha lejos:</strong> acércate al micrófono y revisa el volumen
                de entrada en el sistema (Configuración → Sonido → Micrófono).
              </p>
              <p>
                <strong>Si está muy fuerte:</strong> aléjate un poco o baja el volumen de
                entrada.
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => start(deviceId || undefined)}
                disabled={starting}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60 cursor-pointer"
              >
                {starting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Probar de nuevo
              </button>
              <button
                onClick={onClose}
                className="rounded-xl bg-indigo-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 cursor-pointer"
              >
                Cerrar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
