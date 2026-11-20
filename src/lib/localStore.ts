import type { EvaluationResult, Project, WordExplanation } from '../types';
import { cleanSpanishPhonetic } from '../shared/phonetics';
import { createSofiaSeedProject } from '../shared/sofiaScript';

const DB_NAME = 'vozfacil-studio-db';
const DB_VERSION = 1;

const STORES = {
  projects: 'projects',
  audioBlobs: 'audioBlobs',
  evaluations: 'evaluations',
  ttsCache: 'ttsCache',
  wordCache: 'wordCache',
} as const;

export const IDB_AUDIO_PREFIX = 'idb://audio/';
const MAX_EVALUATIONS = 50;
const MAX_TTS_CACHE = 200;

interface AudioRecord {
  filename: string;
  blob: Blob;
  sizeBytes: number;
  createdAt: string;
}

interface TtsCacheRecord {
  key: string;
  blob: Blob;
  sizeBytes: number;
  createdAt: string;
}

interface WordCacheRecord {
  key: string;
  value: WordExplanation;
  updatedAt: string;
}

export interface LocalStorageStats {
  projectCount: number;
  audioCount: number;
  audioBytes: number;
  ttsCacheCount: number;
  ttsCacheBytes: number;
  evaluationCount: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('Este navegador no soporta IndexedDB para guardar datos locales.')
    );
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.projects)) {
        db.createObjectStore(STORES.projects, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.audioBlobs)) {
        db.createObjectStore(STORES.audioBlobs, { keyPath: 'filename' });
      }
      if (!db.objectStoreNames.contains(STORES.evaluations)) {
        db.createObjectStore(STORES.evaluations, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.ttsCache)) {
        db.createObjectStore(STORES.ttsCache, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.wordCache)) {
        db.createObjectStore(STORES.wordCache, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => {
      dbPromise = null;
      reject(
        new Error(
          req.error?.message ||
            'No se pudo abrir el almacenamiento local (IndexedDB) en este navegador.'
        )
      );
    };
  });

  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new Error(req.error?.message || 'Error en IndexedDB.'));
  });
}

async function withStore<T>(
  storeName: (typeof STORES)[keyof typeof STORES],
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);

  const txDone = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(new Error(tx.error?.message || 'Error guardando en IndexedDB.'));
    tx.onabort = () =>
      reject(new Error(tx.error?.message || 'Operación cancelada en IndexedDB.'));
  });

  const result = await run(store);
  await txDone;
  return result;
}

function randomToken(length = 12): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, length);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.slice(
    0,
    length
  );
}

export function extractIdbFilename(url: string): string | null {
  if (!url || !url.startsWith(IDB_AUDIO_PREFIX)) return null;
  const raw = url.slice(IDB_AUDIO_PREFIX.length).trim();
  return raw || null;
}

export async function loadAudioBlobFromUrl(url: string): Promise<Blob> {
  const idbFilename = extractIdbFilename(url);
  if (idbFilename) {
    const rec = await withStore(STORES.audioBlobs, 'readonly', (store) =>
      requestToPromise<AudioRecord | undefined>(store.get(idbFilename))
    );
    if (!rec?.blob || rec.blob.size === 0) {
      throw new Error('No se pudo cargar el archivo de audio guardado en este navegador.');
    }
    return rec.blob;
  }

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('No se pudo cargar el archivo de audio.');
  }
  const blob = await res.blob();
  if (blob.size === 0) {
    throw new Error('El archivo de audio recibido está vacío.');
  }
  return blob;
}

export async function saveAudioBlob(
  blob: Blob,
  _preferredName = 'recording.wav'
): Promise<{ filename: string; url: string; sizeBytes: number }> {
  if (!blob || blob.size === 0) {
    throw new Error('No se recibió audio válido para guardar.');
  }
  const filename = `take-${randomToken(12)}.wav`;
  const record: AudioRecord = {
    filename,
    blob,
    sizeBytes: blob.size,
    createdAt: new Date().toISOString(),
  };

  await withStore(STORES.audioBlobs, 'readwrite', (store) =>
    requestToPromise(store.put(record))
  );

  return {
    filename,
    url: `${IDB_AUDIO_PREFIX}${filename}`,
    sizeBytes: blob.size,
  };
}

export async function deleteAudioBlob(filename: string): Promise<void> {
  const clean = String(filename || '').trim();
  if (!clean) return;
  await withStore(STORES.audioBlobs, 'readwrite', (store) =>
    requestToPromise(store.delete(clean))
  );
}

function normalizeAndReconcileProjects(
  projects: Project[],
  validAudioKeys: Set<string>
): { projects: Project[]; dirtyIds: Set<string> } {
  const seed = createSofiaSeedProject();
  const seedMap = new Map(seed.segments.map((s) => [s.id, s]));
  const dirtyIds = new Set<string>();

  const nextProjects = projects.map((proj) => {
    if (!Array.isArray(proj.segments)) return proj;
    let projChanged = false;
    const isSofiaSeed = proj.id === 'sofia-birthday-v1';

    const nextSegments = proj.segments.map((seg) => {
      let nextSeg = seg;

      if (Array.isArray(seg.takes) && seg.takes.length > 0) {
        const validTakes = seg.takes
          .filter((take) => {
            if (!take?.filename || !validAudioKeys.has(take.filename)) {
              projChanged = true;
              return false;
            }
            return true;
          })
          .map((take) => {
            const expectedUrl = `${IDB_AUDIO_PREFIX}${take.filename}`;
            const wf = take.evaluation?.wordFeedback;
            const nextWf =
              Array.isArray(wf) && wf.length > 0
                ? wf.map((item) => ({
                    ...item,
                    phoneticEs: cleanSpanishPhonetic(item?.phoneticEs || ''),
                  }))
                : wf;
            const wfChanged =
              Array.isArray(wf) && JSON.stringify(nextWf) !== JSON.stringify(wf);

            if (take.audioUrl !== expectedUrl || wfChanged) {
              projChanged = true;
              return {
                ...take,
                audioUrl: expectedUrl,
                ...(take.evaluation && wfChanged
                  ? { evaluation: { ...take.evaluation, wordFeedback: nextWf || [] } }
                  : {}),
              };
            }
            return take;
          });

        const selectedStillExists = validTakes.some(
          (t) => t.id === nextSeg.selectedTakeId
        );
        const nextSelected = selectedStillExists
          ? nextSeg.selectedTakeId
          : validTakes[0]?.id || null;

        if (
          validTakes.length !== seg.takes.length ||
          nextSelected !== seg.selectedTakeId ||
          projChanged
        ) {
          projChanged = true;
          nextSeg = {
            ...nextSeg,
            takes: validTakes,
            selectedTakeId: nextSelected,
          };
        }
      }

      if (isSofiaSeed && seedMap.has(nextSeg.id)) {
        const seedSeg = seedMap.get(nextSeg.id)!;
        if (
          nextSeg.phoneticEs !== seedSeg.phoneticEs ||
          nextSeg.translationEs !== seedSeg.translationEs ||
          JSON.stringify(nextSeg.tipsEs) !== JSON.stringify(seedSeg.tipsEs) ||
          JSON.stringify(nextSeg.words) !== JSON.stringify(seedSeg.words)
        ) {
          projChanged = true;
          nextSeg = {
            ...nextSeg,
            phoneticEs: seedSeg.phoneticEs,
            translationEs: seedSeg.translationEs,
            tipsEs: seedSeg.tipsEs,
            words: seedSeg.words,
          };
        }
      } else {
        const cleanedPhonetic = cleanSpanishPhonetic(nextSeg.phoneticEs || '');
        const cleanedWords = Array.isArray(nextSeg.words)
          ? nextSeg.words.map((w) => ({
              ...w,
              phoneticEs: cleanSpanishPhonetic(w?.phoneticEs || ''),
            }))
          : nextSeg.words;

        if (
          cleanedPhonetic !== (nextSeg.phoneticEs || '') ||
          JSON.stringify(cleanedWords) !== JSON.stringify(nextSeg.words)
        ) {
          projChanged = true;
          nextSeg = {
            ...nextSeg,
            phoneticEs: cleanedPhonetic,
            words: cleanedWords,
          };
        }
      }

      return nextSeg;
    });

    if (!projChanged) return proj;
    dirtyIds.add(proj.id);
    return {
      ...proj,
      updatedAt: new Date().toISOString(),
      segments: nextSegments,
    };
  });

  nextProjects.sort((a, b) => {
    if (a.createdAt === b.createdAt) return 0;
    return a.createdAt < b.createdAt ? 1 : -1;
  });

  return { projects: nextProjects, dirtyIds };
}

export async function getProjects(): Promise<Project[]> {
  const [rawProjects, rawAudioKeys] = await Promise.all([
    withStore(STORES.projects, 'readonly', (store) =>
      requestToPromise<Project[]>(store.getAll())
    ),
    withStore(STORES.audioBlobs, 'readonly', (store) =>
      requestToPromise<IDBValidKey[]>(store.getAllKeys())
    ),
  ]);

  if (!rawProjects || rawProjects.length === 0) {
    const seed = createSofiaSeedProject();
    await withStore(STORES.projects, 'readwrite', (store) =>
      requestToPromise(store.put(seed))
    );
    return [seed];
  }

  const validAudioKeys = new Set(rawAudioKeys.map((k) => String(k)));
  const { projects, dirtyIds } = normalizeAndReconcileProjects(
    rawProjects,
    validAudioKeys
  );

  if (dirtyIds.size > 0) {
    await withStore(STORES.projects, 'readwrite', async (store) => {
      for (const proj of projects) {
        if (dirtyIds.has(proj.id)) {
          await requestToPromise(store.put(proj));
        }
      }
    });
  }

  return projects;
}

export async function getProjectById(id: string): Promise<Project | null> {
  const projects = await getProjects();
  return projects.find((p) => p.id === id) || null;
}

export async function saveProject(project: Project): Promise<Project> {
  const existing = await withStore(STORES.projects, 'readonly', (store) =>
    requestToPromise<Project | undefined>(store.get(project.id))
  );

  const saved: Project = {
    ...(existing || {}),
    ...project,
    id: project.id || `proj-${randomToken(8)}`,
    createdAt: project.createdAt || existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await withStore(STORES.projects, 'readwrite', (store) =>
    requestToPromise(store.put(saved))
  );
  return saved;
}

async function deleteProjectAudioBlobs(project: Project | undefined): Promise<void> {
  if (!project || !Array.isArray(project.segments)) return;
  const filenames = new Set<string>();
  for (const seg of project.segments) {
    for (const take of seg.takes || []) {
      if (take?.filename) filenames.add(take.filename);
    }
  }
  if (filenames.size === 0) return;

  await withStore(STORES.audioBlobs, 'readwrite', async (store) => {
    for (const filename of filenames) {
      await requestToPromise(store.delete(filename));
    }
  });
}

export async function deleteProject(id: string): Promise<void> {
  if (id === 'sofia-birthday-v1') {
    throw new Error(
      'El guion base de Sofía no se puede eliminar; puedes reiniciarlo si lo deseas.'
    );
  }
  const existing = await withStore(STORES.projects, 'readonly', (store) =>
    requestToPromise<Project | undefined>(store.get(id))
  );
  if (!existing) {
    throw new Error('Proyecto no encontrado.');
  }

  await deleteProjectAudioBlobs(existing);
  await withStore(STORES.projects, 'readwrite', (store) =>
    requestToPromise(store.delete(id))
  );
}

export async function resetSeedProject(id: string): Promise<Project> {
  if (id !== 'sofia-birthday-v1') {
    throw new Error('Solo el guion original de Sofía soporta reinicio.');
  }
  const existing = await withStore(STORES.projects, 'readonly', (store) =>
    requestToPromise<Project | undefined>(store.get(id))
  );
  await deleteProjectAudioBlobs(existing);

  const fresh = createSofiaSeedProject();
  await withStore(STORES.projects, 'readwrite', (store) =>
    requestToPromise(store.put(fresh))
  );
  return fresh;
}

export async function getEvaluations(): Promise<EvaluationResult[]> {
  const list = await withStore(STORES.evaluations, 'readonly', (store) =>
    requestToPromise<EvaluationResult[]>(store.getAll())
  );

  const sorted = [...list].sort((a, b) => {
    if (a.createdAt === b.createdAt) return 0;
    return a.createdAt < b.createdAt ? 1 : -1;
  });

  const dirty: EvaluationResult[] = [];
  const normalized = sorted.map((ev) => {
    if (!Array.isArray(ev?.wordFeedback) || ev.wordFeedback.length === 0) return ev;
    const nextWf = ev.wordFeedback.map((item) => ({
      ...item,
      phoneticEs: cleanSpanishPhonetic(item?.phoneticEs || ''),
    }));
    if (JSON.stringify(nextWf) === JSON.stringify(ev.wordFeedback)) return ev;
    const updated = { ...ev, wordFeedback: nextWf };
    dirty.push(updated);
    return updated;
  });

  if (dirty.length > 0) {
    await withStore(STORES.evaluations, 'readwrite', async (store) => {
      for (const item of dirty) {
        await requestToPromise(store.put(item));
      }
    });
  }

  return normalized;
}

export async function addEvaluation(evaluation: EvaluationResult): Promise<EvaluationResult> {
  const existing = await getEvaluations();
  const toDelete = existing.slice(MAX_EVALUATIONS - 1).map((e) => e.id);

  await withStore(STORES.evaluations, 'readwrite', async (store) => {
    await requestToPromise(store.put(evaluation));
    for (const id of toDelete) {
      await requestToPromise(store.delete(id));
    }
  });

  return evaluation;
}

export async function deleteEvaluation(id: string): Promise<void> {
  await withStore(STORES.evaluations, 'readwrite', (store) =>
    requestToPromise(store.delete(id))
  );
}

function makeTtsCacheKey(voiceId: string, text: string): string {
  return `${voiceId}::${text.trim().toLowerCase()}`;
}

export async function getCachedTts(voiceId: string, text: string): Promise<Blob | null> {
  const key = makeTtsCacheKey(voiceId, text);
  const rec = await withStore(STORES.ttsCache, 'readonly', (store) =>
    requestToPromise<TtsCacheRecord | undefined>(store.get(key))
  );
  return rec?.blob && rec.blob.size > 0 ? rec.blob : null;
}

export async function setCachedTts(
  voiceId: string,
  text: string,
  blob: Blob
): Promise<void> {
  if (!blob || blob.size === 0) return;
  const key = makeTtsCacheKey(voiceId, text);
  const record: TtsCacheRecord = {
    key,
    blob,
    sizeBytes: blob.size,
    createdAt: new Date().toISOString(),
  };

  await withStore(STORES.ttsCache, 'readwrite', async (store) => {
    await requestToPromise(store.put(record));
    const all = await requestToPromise<TtsCacheRecord[]>(store.getAll());
    if (all.length > MAX_TTS_CACHE) {
      all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      const removeCount = all.length - MAX_TTS_CACHE;
      for (let i = 0; i < removeCount; i++) {
        await requestToPromise(store.delete(all[i].key));
      }
    }
  });
}

export async function clearTtsCache(): Promise<void> {
  await withStore(STORES.ttsCache, 'readwrite', (store) =>
    requestToPromise(store.clear())
  );
}

export async function getCachedWord(key: string): Promise<WordExplanation | null> {
  const cleanKey = key.trim().toLowerCase();
  if (!cleanKey) return null;
  const rec = await withStore(STORES.wordCache, 'readonly', (store) =>
    requestToPromise<WordCacheRecord | undefined>(store.get(cleanKey))
  );
  if (!rec?.value) return null;
  return {
    ...rec.value,
    phoneticEs: cleanSpanishPhonetic(rec.value.phoneticEs || ''),
    syllablesEs: '',
  };
}

export async function setCachedWord(
  key: string,
  value: WordExplanation
): Promise<void> {
  const cleanKey = key.trim().toLowerCase();
  if (!cleanKey) return;
  await withStore(STORES.wordCache, 'readwrite', (store) =>
    requestToPromise(
      store.put({
        key: cleanKey,
        value,
        updatedAt: new Date().toISOString(),
      } satisfies WordCacheRecord)
    )
  );
}

export async function getStorageStats(): Promise<LocalStorageStats> {
  const [projects, audioRecs, ttsRecs, evaluations] = await Promise.all([
    withStore(STORES.projects, 'readonly', (store) =>
      requestToPromise<Project[]>(store.getAll())
    ),
    withStore(STORES.audioBlobs, 'readonly', (store) =>
      requestToPromise<AudioRecord[]>(store.getAll())
    ),
    withStore(STORES.ttsCache, 'readonly', (store) =>
      requestToPromise<TtsCacheRecord[]>(store.getAll())
    ),
    withStore(STORES.evaluations, 'readonly', (store) =>
      requestToPromise<EvaluationResult[]>(store.getAll())
    ),
  ]);

  const audioBytes = audioRecs.reduce(
    (sum, item) => sum + (item.sizeBytes || item.blob?.size || 0),
    0
  );
  const ttsCacheBytes = ttsRecs.reduce(
    (sum, item) => sum + (item.sizeBytes || item.blob?.size || 0),
    0
  );

  return {
    projectCount: projects.length,
    audioCount: audioRecs.length,
    audioBytes,
    ttsCacheCount: ttsRecs.length,
    ttsCacheBytes,
    evaluationCount: evaluations.length,
  };
}
