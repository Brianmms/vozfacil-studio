import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  clearDeepSeekApiKey,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  getDeepSeekSettings,
  saveDeepSeekSettings,
} from '../lib/settings';
import { testDeepSeekConnection } from '../lib/deepseekClient';
import {
  clearTtsCache,
  getStorageStats,
  type LocalStorageStats,
} from '../lib/localStore';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(1)} MB`;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_DEEPSEEK_BASE_URL);
  const [model, setModel] = useState(DEFAULT_DEEPSEEK_MODEL);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const [testing, setTesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const [stats, setStats] = useState<LocalStorageStats | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const current = getDeepSeekSettings();
    setApiKey(current.apiKey);
    setBaseUrl(current.baseUrl);
    setModel(current.model);
    setHasSavedKey(Boolean(current.apiKey));
    setStatusMessage(null);
    setShowKey(false);

    getStorageStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleTest = async () => {
    setTesting(true);
    setStatusMessage(null);
    try {
      const cleanUrl = baseUrl.trim().replace(/\/+$/, '') || DEFAULT_DEEPSEEK_BASE_URL;
      const cleanModel = model.trim() || DEFAULT_DEEPSEEK_MODEL;
      const res = await testDeepSeekConnection({
        apiKey: apiKey.trim(),
        baseUrl: cleanUrl,
        model: cleanModel,
      });
      setStatusMessage({
        type: 'success',
        text: `Conexión exitosa con DeepSeek (${res.model}). Puedes guardar tu clave.`,
      });
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'No se pudo validar la API Key de DeepSeek.',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const saved = saveDeepSeekSettings({
      apiKey,
      baseUrl,
      model,
    });
    setHasSavedKey(Boolean(saved.apiKey));
    onClose();
  };

  const handleClearKey = () => {
    clearDeepSeekApiKey();
    setApiKey('');
    setHasSavedKey(false);
    setStatusMessage({
      type: 'success',
      text: 'Clave eliminada de este navegador.',
    });
  };

  const handleResetAdvanced = () => {
    setBaseUrl(DEFAULT_DEEPSEEK_BASE_URL);
    setModel(DEFAULT_DEEPSEEK_MODEL);
  };

  const handleClearTtsCache = async () => {
    setClearingCache(true);
    try {
      await clearTtsCache();
      const refreshed = await getStorageStats();
      setStats(refreshed);
    } finally {
      setClearingCache(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl border border-slate-200 p-5 sm:p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              id="settings-modal-title"
              className="text-lg font-extrabold text-slate-900 flex items-center gap-2"
            >
              <KeyRound className="w-5 h-5 text-indigo-600" />
              Configuración de IA y Almacenamiento
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Cada dispositivo guarda sus propios guiones, audios y clave de forma privada.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar configuración"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="deepseek-api-key-input"
                className="text-xs font-bold text-slate-700"
              >
                API Key de DeepSeek
              </label>
              <a
                href="https://platform.deepseek.com/api_keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 hover:text-indigo-800"
              >
                Obtener clave en DeepSeek
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="relative">
              <input
                id="deepseek-api-key-input"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-xl border border-slate-300 pr-10 pl-3.5 py-2.5 text-sm font-mono focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Ocultar clave' : 'Mostrar clave'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <div className="rounded-xl bg-indigo-50/70 border border-indigo-200/80 px-3 py-2 text-[11px] text-indigo-950 flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
              <span>
                Tu clave se guarda <strong>únicamente en este navegador</strong> (
                <code>localStorage</code>) y viaja directo a <code>api.deepseek.com</code>,
                sin pasar por ningún servidor nuestro.
              </span>
            </div>
          </div>

          {statusMessage && (
            <div
              className={`rounded-xl border px-3.5 py-2.5 text-xs flex items-start gap-2 ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              {statusMessage.type === 'success' && (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              )}
              <span>{statusMessage.text}</span>
            </div>
          )}

          <details className="rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5">
            <summary className="text-xs font-bold text-slate-700 cursor-pointer select-none">
              Opciones avanzadas (modelo y URL base)
            </summary>
            <div className="mt-3 space-y-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-600 mb-1">
                  Modelo de chat
                </label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-mono focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-600 mb-1">
                  URL base de API
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-mono focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={handleResetAdvanced}
                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-600 hover:text-indigo-700 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                Restaurar valores por defecto
              </button>
            </div>
          </details>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || !apiKey.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
              >
                {testing && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" />}
                {testing ? 'Probando...' : 'Probar conexión'}
              </button>

              {hasSavedKey && (
                <button
                  type="button"
                  onClick={handleClearKey}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-100 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Borrar clave
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl px-3.5 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="rounded-xl bg-indigo-600 px-4 py-2 text-xs sm:text-sm font-bold text-white hover:bg-indigo-700 cursor-pointer shadow-xs"
              >
                Guardar
              </button>
            </div>
          </div>
        </form>

        {/* Local device IndexedDB summary */}
        <div className="border-t border-slate-200 pt-4 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-indigo-600" />
              Almacenamiento en este dispositivo (IndexedDB)
            </h3>
            {stats && stats.ttsCacheCount > 0 && (
              <button
                type="button"
                onClick={handleClearTtsCache}
                disabled={clearingCache}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700 hover:text-amber-900 cursor-pointer disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" />
                {clearingCache ? 'Limpiando...' : 'Limpiar caché de voces'}
              </button>
            )}
          </div>

          {stats ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-2">
                <div className="text-sm font-extrabold text-slate-900">
                  {stats.projectCount}
                </div>
                <div className="text-[11px] text-slate-500">Guiones</div>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-2">
                <div className="text-sm font-extrabold text-slate-900">
                  {stats.audioCount}
                </div>
                <div className="text-[11px] text-slate-500">
                  Tus audios ({formatBytes(stats.audioBytes)})
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-2">
                <div className="text-sm font-extrabold text-slate-900">
                  {stats.ttsCacheCount}
                </div>
                <div className="text-[11px] text-slate-500">
                  Voces TTS ({formatBytes(stats.ttsCacheBytes)})
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-2">
                <div className="text-sm font-extrabold text-slate-900">
                  {stats.evaluationCount}
                </div>
                <div className="text-[11px] text-slate-500">Evaluaciones</div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-slate-500 flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5" />
              Cargando espacio usado...
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
