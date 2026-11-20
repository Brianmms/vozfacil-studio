import React, { useMemo, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import type { Project } from '../types';
import { prepareScriptApi } from '../lib/api';
import { applyPlaceholderValues, extractPlaceholders } from '../lib/scriptParser';

interface NewScriptModalProps {
  onClose: () => void;
  onCreated: (project: Project, usedAI: boolean) => void;
}

export const NewScriptModal: React.FC<NewScriptModalProps> = ({ onClose, onCreated }) => {
  const [title, setTitle] = useState('');
  const [rawText, setRawText] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeholderTokens = useMemo(() => extractPlaceholders(rawText), [rawText]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rawText.trim()) {
      setError('Pega primero el texto en inglés que quieres practicar.');
      return;
    }

    const missing = placeholderTokens.filter(
      (token) => !((values[token.key] || '').trim() || token.defaultValue)
    );
    if (missing.length > 0) {
      setError(`Completa estos datos: ${missing.map((token) => token.label).join(', ')}`);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await prepareScriptApi({
        title: title.trim() || 'Mi nuevo guion en inglés',
        rawText: applyPlaceholderValues(rawText.trim(), values),
        save: true,
      });
      onCreated(res.project, res.usedAI);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo preparar el texto.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl bg-white shadow-2xl border border-slate-200 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-indigo-600" />
              Nuevo texto para practicar por partes
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Pega cualquier texto en inglés. Los <code>(...)</code> son pausas/tono y cada{' '}
              <code>[...]</code> (nombre, comida, lugar…) se convierte en un campo para completar.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Nombre del guion
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej: Presentación de mi familia"
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Texto en inglés completo
            </label>
            <textarea
              rows={7}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder="Pega aquí el texto en inglés..."
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </div>

          {placeholderTokens.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 space-y-2">
              <p className="text-[11px] font-bold text-slate-600">
                Completa los datos de tu guion (se detectaron {placeholderTokens.length}):
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {placeholderTokens.map((token) => (
                  <label key={token.key} className="block">
                    <span className="block text-[11px] font-semibold text-slate-500 mb-0.5">
                      {token.label}
                    </span>
                    <input
                      type="text"
                      value={values[token.key] ?? ''}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [token.key]: e.target.value }))
                      }
                      placeholder={token.defaultValue || token.label}
                      className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2.5 text-xs text-rose-800">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-60 cursor-pointer"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Dividiendo y creando guía...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Dividir y crear guía
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
