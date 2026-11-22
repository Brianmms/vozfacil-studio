import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  KeyRound,
  Loader2,
  Mic,
  SearchCheck,
  Settings,
  Sliders,
  Volume2,
} from 'lucide-react';
import type { HealthStatus, Project, VoiceId } from './types';
import { fetchHealth, fetchProjects, saveProjectApi } from './lib/api';
import { subscribeSettingsChange } from './lib/settings';
import { SOFIA_FULL_RAW_TEXT } from './shared/sofiaScript';
import { CelebrationOverlay } from './components/CelebrationOverlay';
import { EvaluatorView } from './components/EvaluatorView';
import { PracticeView } from './components/PracticeView';
import { SettingsModal } from './components/SettingsModal';
import { StudioView } from './components/StudioView';

type TabKey = 'practice' | 'studio' | 'evaluate';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>('practice');
  const [voiceId, setVoiceId] = useState<VoiceId>('stella');
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [celebration, setCelebration] = useState<{
    show: boolean;
    message: string;
    score?: number;
    key: number;
  }>({
    show: false,
    message: '¡Súper bien! 🐞✨',
    key: 0,
  });

  const triggerCelebration = useCallback((score: number, customMessage?: string) => {
    const rounded = Math.round(score);
    if (rounded <= 95) return;
    const defaultMsg =
      rounded >= 100 ? '¡PERFECTO! 🏆🐞' : '¡Súper bien! 🐞✨';
    setCelebration((prev) => ({
      show: true,
      message: customMessage || defaultMsg,
      score: rounded,
      key: prev.key + 1,
    }));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const previewParam = params.get('celebrate');
    if (previewParam !== null) {
      const score = Number(previewParam);
      if (Number.isFinite(score) && score > 95) {
        triggerCelebration(score);
      }
    }

    const onCelebrateEvent = (event: Event) => {
      const detail = (
        event as CustomEvent<{ score?: number; message?: string }>
      ).detail;
      const score = typeof detail?.score === 'number' ? detail.score : 96;
      if (score > 95) {
        triggerCelebration(score, detail?.message);
      }
    };
    window.addEventListener('vozfacil:celebrate', onCelebrateEvent);
    return () => window.removeEventListener('vozfacil:celebrate', onCelebrateEvent);
  }, [triggerCelebration]);

  const refreshHealth = useCallback(async () => {
    const status = await fetchHealth();
    setHealth(status);
  }, []);

  useEffect(() => {
    refreshHealth();
    const unsub = subscribeSettingsChange(() => {
      refreshHealth();
    });
    return unsub;
  }, [refreshHealth]);

  useEffect(() => {
    Promise.all([fetchHealth(), fetchProjects()])
      .then(([h, list]) => {
        setHealth(h);
        setProjects(list);
        if (list.length > 0) {
          setActiveProjectId(list[0].id);
        }
      })
      .catch((err) => {
        setError(
          err instanceof Error
            ? err.message
            : 'No se pudo inicializar el almacenamiento local del navegador.'
        );
      })
      .finally(() => setLoading(false));
  }, []);

  const handleUpdateProject = async (updated: Project) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === updated.id ? updated : p))
    );
    const saved = await saveProjectApi(updated);
    setProjects((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
  };

  const handleAddProject = (project: Project) => {
    setProjects((prev) => [project, ...prev]);
    setActiveProjectId(project.id);
    setActiveTab('practice');
  };

  const handleRemoveProject = (id: string) => {
    setProjects((prev) => {
      const remaining = prev.filter((p) => p.id !== id);
      if (activeProjectId === id && remaining.length > 0) {
        setActiveProjectId(remaining[0].id);
      }
      return remaining;
    });
  };

  const activeProject =
    projects.find((p) => p.id === activeProjectId) || projects[0];
  const hasApiKey = Boolean(health?.hasApiKey);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white flex items-center justify-center shadow-sm shrink-0">
              <Mic className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-extrabold tracking-tight text-slate-900">
                VozFácil Studio
              </h1>
              <p className="text-xs text-slate-500">
                Practica inglés paso a paso, evalúa tu voz y une grabaciones
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Voice selector */}
            <div className="inline-flex items-center gap-1.5 rounded-xl bg-slate-100 border border-slate-200 px-2.5 py-1.5 text-xs">
              <Volume2 className="w-3.5 h-3.5 text-indigo-600" />
              <span className="font-semibold text-slate-600">Voz guía:</span>
              <select
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value as VoiceId)}
                className="bg-transparent font-bold text-slate-800 focus:outline-none cursor-pointer"
              >
                <option value="stella">Stella (Mujer)</option>
                <option value="tide">Tide (Hombre)</option>
              </select>
            </div>

            {/* Interactive DeepSeek API Key / Settings button */}
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                hasApiKey
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100'
                  : 'bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100'
              }`}
              title="Configurar API Key de DeepSeek y ver almacenamiento local"
            >
              {hasApiKey ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  <span>DeepSeek listo ({health?.model || 'deepseek-flash'})</span>
                  <Settings className="w-3.5 h-3.5 opacity-70" />
                </>
              ) : (
                <>
                  <KeyRound className="w-3.5 h-3.5 text-amber-700" />
                  <span>Configurar API Key</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* 3 Clear Tabs */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-2.5 pt-1">
          <nav className="grid grid-cols-3 gap-2 sm:inline-flex sm:gap-2 rounded-2xl bg-slate-100 p-1">
            <button
              onClick={() => setActiveTab('practice')}
              className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-bold transition cursor-pointer ${
                activeTab === 'practice'
                  ? 'bg-white text-indigo-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <BookOpen className="w-4 h-4 shrink-0" />
              <span className="truncate">1. Practicar por Partes</span>
            </button>

            <button
              onClick={() => setActiveTab('studio')}
              className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-bold transition cursor-pointer ${
                activeTab === 'studio'
                  ? 'bg-white text-indigo-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Sliders className="w-4 h-4 shrink-0" />
              <span className="truncate">2. Estudio y Unir Audios</span>
            </button>

            <button
              onClick={() => setActiveTab('evaluate')}
              className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-bold transition cursor-pointer ${
                activeTab === 'evaluate'
                  ? 'bg-white text-indigo-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <SearchCheck className="w-4 h-4 shrink-0" />
              <span className="truncate">3. Evaluar Texto + Audio</span>
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 space-y-5">
        {health && !hasApiKey && (
          <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs sm:text-sm text-amber-950">
            <div>
              <span className="font-bold">Modo local sin clave IA:</span> puedes practicar
              por partes, escuchar la voz del navegador, grabar tu voz y editar/exportar en
              el estudio gratis. Para evaluar pronunciación con IA o usar la voz natural de
              DeepSeek, agrega tu clave.
            </div>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-amber-700 shrink-0 cursor-pointer"
            >
              <KeyRound className="w-3.5 h-3.5" />
              Configurar API Key
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-500 gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
            <p className="text-sm font-semibold">Cargando tu estudio de práctica...</p>
          </div>
        ) : error ? (
          <div className="rounded-2xl bg-rose-50 border border-rose-200 p-6 text-center space-y-2">
            <p className="text-sm font-bold text-rose-900">{error}</p>
            <p className="text-xs text-rose-700">
              Verifica que tu navegador permita almacenamiento local (IndexedDB) y no estés
              bloqueando el almacenamiento del sitio.
            </p>
          </div>
        ) : (
          <>
            {activeTab === 'practice' && (
              <PracticeView
                projects={projects}
                activeProjectId={activeProjectId}
                voiceId={voiceId}
                hasApiKey={hasApiKey}
                onSelectProject={setActiveProjectId}
                onUpdateProject={handleUpdateProject}
                onAddProject={handleAddProject}
                onRemoveProject={handleRemoveProject}
                onGoToStudio={() => setActiveTab('studio')}
                onOpenSettings={() => setShowSettings(true)}
                onCelebrate={triggerCelebration}
              />
            )}

            {activeTab === 'studio' && activeProject && (
              <StudioView
                project={activeProject}
                voiceId={voiceId}
                hasApiKey={hasApiKey}
                onUpdateProject={handleUpdateProject}
                onGoToPractice={() => setActiveTab('practice')}
                onOpenSettings={() => setShowSettings(true)}
                onCelebrate={triggerCelebration}
              />
            )}

            {activeTab === 'evaluate' && (
              <EvaluatorView
                voiceId={voiceId}
                sofiaFullText={SOFIA_FULL_RAW_TEXT}
                hasApiKey={hasApiKey}
                onImportProject={handleAddProject}
                onOpenSettings={() => setShowSettings(true)}
                onCelebrate={triggerCelebration}
              />
            )}
          </>
        )}
      </main>

      <footer className="border-t border-slate-200/80 bg-white/70 py-3 px-4 text-center text-[11px] text-slate-500">
        Tus grabaciones, guiones y clave DeepSeek se guardan de forma privada únicamente en
        este dispositivo y navegador.
      </footer>

      <CelebrationOverlay
        show={celebration.show}
        message={celebration.message}
        score={celebration.score}
        triggerKey={celebration.key}
        onDone={() => setCelebration((prev) => ({ ...prev, show: false }))}
      />

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
};

export default App;
