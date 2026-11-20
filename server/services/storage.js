import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSofiaSeedProject } from '../data/sofiaScript.js';
import { cleanSpanishPhonetic } from './phonetics.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts-cache');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const EVALUATIONS_FILE = path.join(DATA_DIR, 'evaluations.json');
const WORD_CACHE_FILE = path.join(DATA_DIR, 'word-cache.json');

export function ensureDataDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
}

function readJson(filePath, fallbackValue) {
  ensureDataDirs();
  if (!fs.existsSync(filePath)) return fallbackValue;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  ensureDataDirs();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function reconcileMissingAudio(projects) {
  let changed = false;
  const cleaned = projects.map((proj) => {
    if (!Array.isArray(proj.segments)) return proj;
    let projChanged = false;
    const nextSegments = proj.segments.map((seg) => {
      if (!Array.isArray(seg.takes) || seg.takes.length === 0) return seg;
      const existingTakes = seg.takes.filter((take) => {
        if (!take?.filename) {
          projChanged = true;
          return false;
        }
        const ok = Boolean(resolveSafeAudioPath(take.filename));
        if (!ok) projChanged = true;
        return ok;
      });
      if (existingTakes.length === seg.takes.length) return seg;

      const selectedStillExists = existingTakes.some(
        (t) => t.id === seg.selectedTakeId
      );
      return {
        ...seg,
        takes: existingTakes,
        selectedTakeId: selectedStillExists
          ? seg.selectedTakeId
          : existingTakes[0]?.id || null,
      };
    });

    if (!projChanged) return proj;
    changed = true;
    return {
      ...proj,
      updatedAt: new Date().toISOString(),
      segments: nextSegments,
    };
  });
  return { cleaned, changed };
}

function syncAndCleanPhonetics(projects) {
  let changed = false;
  const seedMap = new Map(
    createSofiaSeedProject().segments.map((s) => [s.id, s])
  );

  const nextProjects = projects.map((proj) => {
    if (!Array.isArray(proj.segments)) return proj;
    let projChanged = false;
    const isSofiaSeed = proj.id === 'sofia-birthday-v1';

    const nextSegments = proj.segments.map((seg) => {
      let nextSeg = seg;
      if (isSofiaSeed && seedMap.has(seg.id)) {
        const seedSeg = seedMap.get(seg.id);
        if (
          seg.phoneticEs !== seedSeg.phoneticEs ||
          seg.translationEs !== seedSeg.translationEs ||
          JSON.stringify(seg.tipsEs) !== JSON.stringify(seedSeg.tipsEs) ||
          JSON.stringify(seg.words) !== JSON.stringify(seedSeg.words)
        ) {
          projChanged = true;
          nextSeg = {
            ...seg,
            phoneticEs: seedSeg.phoneticEs,
            translationEs: seedSeg.translationEs,
            tipsEs: seedSeg.tipsEs,
            words: seedSeg.words,
          };
        }
      } else {
        const cleanedPhonetic = cleanSpanishPhonetic(seg.phoneticEs || '');
        const cleanedWords = Array.isArray(seg.words)
          ? seg.words.map((w) => ({
              ...w,
              phoneticEs: cleanSpanishPhonetic(w?.phoneticEs || ''),
            }))
          : seg.words;
        if (
          cleanedPhonetic !== (seg.phoneticEs || '') ||
          JSON.stringify(cleanedWords) !== JSON.stringify(seg.words)
        ) {
          projChanged = true;
          nextSeg = {
            ...seg,
            phoneticEs: cleanedPhonetic,
            words: cleanedWords,
          };
        }
      }

      if (Array.isArray(nextSeg.takes) && nextSeg.takes.length > 0) {
        let takesChanged = false;
        const nextTakes = nextSeg.takes.map((take) => {
          const wf = take?.evaluation?.wordFeedback;
          if (!Array.isArray(wf) || wf.length === 0) return take;
          const nextWf = wf.map((item) => ({
            ...item,
            phoneticEs: cleanSpanishPhonetic(item?.phoneticEs || ''),
          }));
          if (JSON.stringify(nextWf) === JSON.stringify(wf)) return take;
          takesChanged = true;
          return {
            ...take,
            evaluation: {
              ...take.evaluation,
              wordFeedback: nextWf,
            },
          };
        });
        if (takesChanged) {
          projChanged = true;
          nextSeg = { ...nextSeg, takes: nextTakes };
        }
      }

      return nextSeg;
    });

    if (!projChanged) return proj;
    changed = true;
    return {
      ...proj,
      updatedAt: new Date().toISOString(),
      segments: nextSegments,
    };
  });

  return { projects: nextProjects, changed };
}

export function getProjects() {
  let projects = readJson(PROJECTS_FILE, null);
  if (!Array.isArray(projects) || projects.length === 0) {
    projects = [createSofiaSeedProject()];
    writeJson(PROJECTS_FILE, projects);
    return projects;
  }
  const { cleaned, changed: audioChanged } = reconcileMissingAudio(projects);
  const { projects: normalized, changed: phoneticsChanged } =
    syncAndCleanPhonetics(cleaned);
  if (audioChanged || phoneticsChanged) {
    writeJson(PROJECTS_FILE, normalized);
  }
  return normalized;
}

export function getProjectById(id) {
  return getProjects().find((p) => p.id === id) || null;
}

export function saveProject(project) {
  const projects = getProjects();
  const idx = projects.findIndex((p) => p.id === project.id);
  const updated = {
    ...project,
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    projects[idx] = updated;
  } else {
    projects.unshift(updated);
  }
  writeJson(PROJECTS_FILE, projects);
  return updated;
}

export function deleteProject(id) {
  const projects = getProjects();
  const filtered = projects.filter((p) => p.id !== id);
  writeJson(PROJECTS_FILE, filtered);
  return filtered.length < projects.length;
}

export function resetSeedProject(id) {
  if (id !== 'sofia-birthday-v1') return null;
  const existing = getProjectById(id);
  if (existing && Array.isArray(existing.segments)) {
    for (const seg of existing.segments) {
      for (const take of seg.takes || []) {
        if (take?.filename) {
          try {
            deleteAudioFile(take.filename);
          } catch {
            // Ignore missing file
          }
        }
      }
    }
  }
  const fresh = createSofiaSeedProject();
  return saveProject(fresh);
}

export function getEvaluations() {
  const list = readJson(EVALUATIONS_FILE, []);
  if (!Array.isArray(list)) return [];
  let changed = false;
  const cleaned = list.map((ev) => {
    if (!Array.isArray(ev?.wordFeedback) || ev.wordFeedback.length === 0) return ev;
    const nextWf = ev.wordFeedback.map((item) => ({
      ...item,
      phoneticEs: cleanSpanishPhonetic(item?.phoneticEs || ''),
    }));
    if (JSON.stringify(nextWf) === JSON.stringify(ev.wordFeedback)) return ev;
    changed = true;
    return { ...ev, wordFeedback: nextWf };
  });
  if (changed) {
    writeJson(EVALUATIONS_FILE, cleaned);
  }
  return cleaned;
}

export function addEvaluation(evaluation) {
  const list = getEvaluations();
  const entry = {
    id: evaluation.id || crypto.randomUUID(),
    createdAt: evaluation.createdAt || new Date().toISOString(),
    ...evaluation,
  };
  list.unshift(entry);
  const trimmed = list.slice(0, 50);
  writeJson(EVALUATIONS_FILE, trimmed);
  return entry;
}

export function deleteEvaluation(id) {
  const list = getEvaluations();
  const filtered = list.filter((e) => e.id !== id);
  writeJson(EVALUATIONS_FILE, filtered);
  return filtered.length < list.length;
}

export function getCachedWord(key) {
  const cache = readJson(WORD_CACHE_FILE, {});
  const entry = cache[key] || null;
  if (!entry) return null;
  const cleanedPhonetic = cleanSpanishPhonetic(entry.phoneticEs || '');
  const cleanEntry = {
    ...entry,
    phoneticEs: cleanedPhonetic,
    syllablesEs: '',
  };
  if (
    cleanedPhonetic !== (entry.phoneticEs || '') ||
    (entry.syllablesEs && entry.syllablesEs.includes('-'))
  ) {
    cache[key] = cleanEntry;
    writeJson(WORD_CACHE_FILE, cache);
  }
  return cleanEntry;
}

export function setCachedWord(key, value) {
  const cache = readJson(WORD_CACHE_FILE, {});
  cache[key] = value;
  writeJson(WORD_CACHE_FILE, cache);
}

export function getTtsCachePath(voiceId, text) {
  ensureDataDirs();
  const hash = crypto
    .createHash('sha256')
    .update(`${voiceId}::${text.trim()}`)
    .digest('hex');
  return path.join(TTS_CACHE_DIR, `${hash}.wav`);
}

export function readTtsCache(voiceId, text) {
  const filePath = getTtsCachePath(voiceId, text);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath);
  }
  return null;
}

export function writeTtsCache(voiceId, text, buffer) {
  const filePath = getTtsCachePath(voiceId, text);
  fs.writeFileSync(filePath, buffer);
}

export function saveAudioBuffer(buffer) {
  ensureDataDirs();
  const filename = `${crypto.randomUUID()}.wav`;
  const filePath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return filename;
}

export function resolveSafeAudioPath(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName || !safeName.endsWith('.wav') || !/^[a-zA-Z0-9_-]+\.wav$/.test(safeName)) {
    return null;
  }
  const fullPath = path.join(AUDIO_DIR, safeName);
  if (!fs.existsSync(fullPath)) return null;
  return fullPath;
}

export function deleteAudioFile(filename) {
  const fullPath = resolveSafeAudioPath(filename);
  if (!fullPath) return false;
  fs.unlinkSync(fullPath);
  return true;
}
