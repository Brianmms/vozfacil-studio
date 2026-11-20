import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { getDeepSeekConfig } from './config.js';
import { alignWords } from './services/alignment.js';
import {
  DeepSeekError,
  explainWordWithAI,
  generatePronunciationFeedback,
  prepareScriptWithAI,
  synthesizeSpeech,
  transcribeAudioBuffers,
} from './services/deepseek.js';
import {
  addEvaluation,
  deleteAudioFile,
  deleteEvaluation,
  deleteProject,
  ensureDataDirs,
  getEvaluations,
  getProjectById,
  getProjects,
  resetSeedProject,
  resolveSafeAudioPath,
  saveAudioBuffer,
  saveProject,
} from './services/storage.js';

ensureDataDirs();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB per uploaded WAV chunk
    files: 12,
  },
});

app.use(express.json({ limit: '15mb' }));

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// 1. Health & config check
app.get('/api/health', (req, res) => {
  const cfg = getDeepSeekConfig();
  res.json({
    ok: true,
    hasApiKey: cfg.hasApiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    ffmpegInstalled: false,
    audioEngine: 'Web Audio API (navegador) + WAV local',
  });
});

// 2. Projects CRUD
app.get('/api/projects', (req, res) => {
  res.json({ projects: getProjects() });
});

app.post('/api/projects', (req, res) => {
  const body = req.body || {};
  if (!body.title || !Array.isArray(body.segments)) {
    return res.status(400).json({ error: 'Se requiere título y partes del guion.' });
  }
  const project = {
    id: body.id || `proj-${crypto.randomUUID().slice(0, 8)}`,
    title: String(body.title).trim(),
    description: String(body.description || '').trim(),
    createdAt: body.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    segments: body.segments,
  };
  const saved = saveProject(project);
  res.status(201).json({ project: saved });
});

app.put('/api/projects/:id', (req, res) => {
  const existing = getProjectById(req.params.id);
  const incoming = req.body || {};
  if (!existing && !incoming.segments) {
    return res.status(404).json({ error: 'Proyecto no encontrado.' });
  }
  const merged = {
    ...(existing || {}),
    ...incoming,
    id: req.params.id,
  };
  const saved = saveProject(merged);
  res.json({ project: saved });
});

app.delete('/api/projects/:id', (req, res) => {
  if (req.params.id === 'sofia-birthday-v1') {
    return res.status(400).json({
      error: 'El guion base de Sofía no se puede eliminar; puedes reiniciarlo si lo deseas.',
    });
  }
  const deleted = deleteProject(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Proyecto no encontrado.' });
  }
  res.json({ ok: true });
});

app.post('/api/projects/:id/reset', (req, res) => {
  const reset = resetSeedProject(req.params.id);
  if (!reset) {
    return res.status(404).json({ error: 'Solo el guion original de Sofía soporta reinicio.' });
  }
  res.json({ project: reset });
});

// 3. AI Coach endpoints
app.post(
  '/api/coach/prepare-script',
  asyncHandler(async (req, res) => {
    const { title, rawText, save = false } = req.body || {};
    if (!rawText || !String(rawText).trim()) {
      return res.status(400).json({ error: 'Pega un texto en inglés antes de preparar el guion.' });
    }
    const result = await prepareScriptWithAI({ title, rawText });
    const project = save ? saveProject(result.project) : result.project;
    res.json({ project, usedAI: result.usedAI });
  })
);

app.post(
  '/api/coach/word',
  asyncHandler(async (req, res) => {
    const { word, context } = req.body || {};
    const info = await explainWordWithAI({ word, context });
    res.json(info);
  })
);

// 4. Text-to-Speech (cached locally)
app.post(
  '/api/tts',
  asyncHandler(async (req, res) => {
    const { text, voiceId = 'stella' } = req.body || {};
    const wavBuffer = await synthesizeSpeech({ text, voiceId });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', wavBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(wavBuffer);
  })
);

// 5. ASR Speech-to-Text
app.post(
  '/api/asr',
  upload.array('files', 12),
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'Debes adjuntar al menos un archivo WAV.' });
    }
    const buffers = files.map((f) => f.buffer);
    const transcript = await transcribeAudioBuffers(buffers);
    res.json(transcript);
  })
);

// 6. Full pronunciation evaluation (ASR + Alignment + DeepSeek Flash coaching)
app.post(
  '/api/evaluate',
  upload.array('files', 12),
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    const expectedText = String(req.body?.expectedText || '').trim();
    const ignoreParentheses = req.body?.ignoreParentheses !== 'false';
    const saveHistory = req.body?.saveHistory === 'true';

    if (!expectedText) {
      return res.status(400).json({ error: 'Falta el texto esperado en inglés.' });
    }
    if (files.length === 0) {
      return res.status(400).json({ error: 'Falta el audio para evaluar.' });
    }

    const buffers = files.map((f) => f.buffer);
    const asr = await transcribeAudioBuffers(buffers);
    const alignment = alignWords(expectedText, asr.text, { ignoreParentheses });
    const feedback = await generatePronunciationFeedback({
      expectedText,
      transcribedText: asr.text,
      alignment,
    });

    const payload = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      expectedText: alignment.expectedClean,
      transcribedText: asr.text,
      durationMs: asr.durationMs,
      score: feedback.adjustedScore,
      alignmentScore: alignment.score,
      wordAccuracy: alignment.wordAccuracy,
      completeness: alignment.completeness,
      words: alignment.words,
      extraWords: alignment.extraWords,
      encouragingTitle: feedback.encouragingTitle,
      summary: feedback.summary,
      wordFeedback: feedback.wordFeedback,
      nextStepTip: feedback.nextStepTip,
    };

    if (saveHistory) {
      addEvaluation(payload);
    }

    res.json(payload);
  })
);

app.get('/api/evaluations', (req, res) => {
  res.json({ evaluations: getEvaluations() });
});

app.delete('/api/evaluations/:id', (req, res) => {
  const ok = deleteEvaluation(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: 'Evaluación no encontrada.' });
  }
  res.json({ ok: true });
});

// 7. Local audio clip storage
app.post('/api/audio/upload', upload.single('file'), (req, res) => {
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: 'No se recibió el archivo de audio.' });
  }
  const filename = saveAudioBuffer(req.file.buffer);
  res.status(201).json({
    filename,
    url: `/api/audio/${filename}`,
    sizeBytes: req.file.buffer.length,
  });
});

app.get('/api/audio/:filename', (req, res) => {
  const filePath = resolveSafeAudioPath(req.params.filename);
  if (!filePath) {
    return res.status(404).json({ error: 'Audio no encontrado.' });
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(filePath, {
    etag: false,
    lastModified: false,
    cacheControl: false,
  });
});

app.delete('/api/audio/:filename', (req, res) => {
  const deleted = deleteAudioFile(req.params.filename);
  if (!deleted) {
    return res.status(404).json({ error: 'Audio no encontrado.' });
  }
  res.json({ ok: true });
});

// Serve built frontend in production
const DIST_DIR = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// Global JSON error handler
app.use((err, req, res, _next) => {
  if (err instanceof DeepSeekError) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
    });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'El archivo de audio excede el límite permitido (15 MB por fragmento).',
      code: 'FILE_TOO_LARGE',
    });
  }
  console.error('[Server Error]', err);
  res.status(500).json({
    error: err?.message || 'Ocurrió un error inesperado en el servidor.',
    code: 'INTERNAL_ERROR',
  });
});

const cfg = getDeepSeekConfig();
app.listen(cfg.port, '0.0.0.0', () => {
  console.log(`VozFácil Studio backend escuchando en http://localhost:${cfg.port}`);
  console.log(
    `DeepSeek API: ${cfg.hasApiKey ? `Configurada (${cfg.model})` : 'Pendiente (agrega DEEPSEEK_API_KEY en .env)'}`
  );
});
