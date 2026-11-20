import React, { useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import type { Project } from '../types';
import { prepareScriptApi } from '../lib/api';
import { applyPlaceholders } from '../lib/scriptParser';

interface NewScriptModalProps {
  onClose: () => void;
  onCreated: (project: Project, usedAI: boolean) => void;
}

export const NewScriptModal: React.FC<NewScriptModalProps> = ({ onClose, onCreated }) => {
  const [title, setTitle] = useState('');
  const [rawText, setRawText] = useState('');
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [grade, setGrade] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rawText.trim()) {
      setError('Pega primero el texto en inglés que quieres practicar.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await prepareScriptApi({
        title: title.trim() || 'Mi nuevo guion en inglés',
        rawText: applyPlaceholders(rawText.trim(), { name, age, grade }),
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
              Pega cualquier texto en inglés. Si incluye notas entre paréntesis como{' '}
              <code>(Pausa breve)</code>, la app las separará como recordatorios de pausa y tono.
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

          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 space-y-2">
            <p className="text-[11px] font-bold text-slate-600">
              Personalizar (opcional) — rellena <code>[tu nombre]</code>,{' '}
              <code>[tu edad]</code> y <code>[tu grado]</code>
            </p>
            <div className="grid grid-cols-3 gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nombre (Sara)"
                className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
              />
              <input
                type="text"
                value={age}
                onChange={(e) => setAge(e.target.value)}
                placeholder="Edad (15)"
                className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
              />
              <input
                type="text"
                value={grade}
                onChange={(e) => setGrade(e.target.value)}
                placeholder="Grado (9)"
                className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

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
