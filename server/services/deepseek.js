import crypto from 'node:crypto';
import { getDeepSeekConfig } from '../config.js';
import { getCachedWord, setCachedWord, readTtsCache, writeTtsCache } from './storage.js';
import { stripStageDirections } from './alignment.js';
import { cleanSpanishPhonetic } from './phonetics.js';

export class DeepSeekError extends Error {
  constructor(message, status = 500, code = 'DEEPSEEK_ERROR') {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.code = code;
  }
}

function requireConfig() {
  const cfg = getDeepSeekConfig();
  if (!cfg.hasApiKey) {
    throw new DeepSeekError(
      'Falta configurar DEEPSEEK_API_KEY en el archivo .env para usar las funciones de IA.',
      400,
      'API_KEY_MISSING'
    );
  }
  return cfg;
}

async function parseErrorMessage(response) {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      return json?.error?.message || json?.message || text;
    } catch {
      return text || `HTTP ${response.status}`;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

function cleanJsonString(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export async function callDeepSeekJson({ systemPrompt, userPrompt, temperature = 0.25 }) {
  const cfg = requireConfig();

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      temperature,
    }),
  });

  if (!res.ok) {
    const detail = await parseErrorMessage(res);
    throw new DeepSeekError(
      `Error en DeepSeek Chat (${res.status}): ${detail}`,
      res.status >= 400 && res.status < 500 ? res.status : 502,
      'DEEPSEEK_CHAT_ERROR'
    );
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new DeepSeekError('DeepSeek devolvió una respuesta vacía.', 502, 'EMPTY_RESPONSE');
  }

  try {
    return JSON.parse(cleanJsonString(content));
  } catch {
    throw new DeepSeekError(
      'DeepSeek no devolvió un JSON válido.',
      502,
      'INVALID_JSON_RESPONSE'
    );
  }
}

export function fixWavHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    return buffer;
  }
  if (
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return buffer;
  }

  const out = Buffer.from(buffer);
  const expectedRiffSize = out.length - 8;
  const currentRiffSize = out.readUInt32LE(4);
  if (currentRiffSize === 0xffffffff || currentRiffSize !== expectedRiffSize) {
    out.writeUInt32LE(expectedRiffSize, 4);
  }

  let offset = 12;
  while (offset + 8 <= out.length) {
    const chunkId = out.toString('ascii', offset, offset + 4);
    const chunkSize = out.readUInt32LE(offset + 4);
    const dataStart = offset + 8;

    if (chunkId === 'data') {
      const actualDataSize = out.length - dataStart;
      if (chunkSize === 0xffffffff || chunkSize > actualDataSize) {
        out.writeUInt32LE(actualDataSize, offset + 4);
      }
      break;
    }

    if (chunkSize === 0xffffffff || dataStart + chunkSize > out.length) {
      break;
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  return out;
}

export async function synthesizeSpeech({ text, voiceId = 'stella' }) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    throw new DeepSeekError('El texto para generar audio no puede estar vacío.', 400, 'EMPTY_TEXT');
  }

  const safeVoice = voiceId === 'tide' ? 'tide' : 'stella';
  const cached = readTtsCache(safeVoice, cleanText);
  if (cached) {
    const fixedCached = fixWavHeader(cached);
    if (Buffer.compare(fixedCached, cached) !== 0) {
      writeTtsCache(safeVoice, cleanText, fixedCached);
    }
    return fixedCached;
  }

  const cfg = requireConfig();
  const res = await fetch(`${cfg.baseUrl}/v1/tools/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: cleanText,
      voice_id: safeVoice,
      format: 'wav',
      filter_markdown: true,
    }),
  });

  if (!res.ok) {
    const detail = await parseErrorMessage(res);
    throw new DeepSeekError(
      `Error en DeepSeek TTS (${res.status}): ${detail}`,
      res.status >= 400 && res.status < 500 ? res.status : 502,
      'DEEPSEEK_TTS_ERROR'
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = fixWavHeader(Buffer.from(arrayBuffer));
  if (buffer.length > 0) {
    writeTtsCache(safeVoice, cleanText, buffer);
  }
  return buffer;
}

export async function transcribeAudioBuffers(wavBuffers) {
  const cfg = requireConfig();
  if (!Array.isArray(wavBuffers) || wavBuffers.length === 0) {
    throw new DeepSeekError('No se recibió ningún archivo de audio.', 400, 'NO_AUDIO');
  }

  const parts = [];
  let totalDurationMs = 0;

  for (let i = 0; i < wavBuffers.length; i++) {
    const buf = wavBuffers[i];
    const form = new FormData();
    const blob = new Blob([buf], { type: 'audio/wav' });
    form.append('file', blob, `chunk-${i + 1}.wav`);

    const res = await fetch(`${cfg.baseUrl}/v1/tools/asr`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: form,
    });

    if (!res.ok) {
      const detail = await parseErrorMessage(res);
      throw new DeepSeekError(
        `Error al transcribir audio con DeepSeek ASR (${res.status}): ${detail}`,
        res.status >= 400 && res.status < 500 ? res.status : 502,
        'DEEPSEEK_ASR_ERROR'
      );
    }

    const json = await res.json();
    if (json?.text) parts.push(String(json.text).trim());
    if (typeof json?.duration_ms === 'number') totalDurationMs += json.duration_ms;
  }

  return {
    text: parts.join(' ').replace(/\s+/g, ' ').trim(),
    durationMs: totalDurationMs,
  };
}

function buildFallbackFeedback(alignment) {
  const problemWords = alignment.words.filter((w) => w.status !== 'correct').slice(0, 6);
  const score = alignment.score;
  let encouragingTitle = '¡Muy buen esfuerzo!';
  if (score >= 90) encouragingTitle = '¡Excelente pronunciación!';
  else if (score >= 75) encouragingTitle = '¡Vas muy bien, casi perfecto!';
  else if (score >= 50) encouragingTitle = '¡Buen avance! Practiquemos algunas palabras';
  else encouragingTitle = '¡No te desanimes, vamos paso a paso!';

  const summary =
    problemWords.length === 0
      ? 'Se entendieron todas las palabras con mucha claridad. Tu ritmo y pronunciación fueron excelentes.'
      : `Lograste una precisión de ${score}%. Practica un poco más ${problemWords.length} palabra(s) marcada(s) en amarillo o rojo y vuelve a grabar.`;

  return {
    adjustedScore: score,
    encouragingTitle,
    summary,
    wordFeedback: problemWords.map((w) => ({
      word: w.expected,
      heard: w.heard || '(no se escuchó)',
      phoneticEs: '',
      tipEs:
        w.status === 'missing'
          ? 'Parece que esta palabra se saltó o sonó muy bajito. Dila un poco más lento y claro.'
          : `La IA escuchó "${w.heard}". Escucha el audio guía de esta palabra y repite su sonido despacio.`,
    })),
    nextStepTip:
      problemWords.length > 0
        ? 'Haz clic en las palabras marcadas para escucharlas lento y repite la frase una vez más.'
        : '¡Lista! Puedes elegir esta toma como final para unirla en el estudio.',
  };
}

export async function generatePronunciationFeedback({ expectedText, transcribedText, alignment }) {
  const fallback = buildFallbackFeedback(alignment);
  const cfg = getDeepSeekConfig();
  if (!cfg.hasApiKey) {
    return fallback;
  }

  const problematic = alignment.words
    .filter((w) => w.status !== 'correct')
    .slice(0, 12)
    .map((w) => ({ expected: w.expected, heard: w.heard, status: w.status }));

  const systemPrompt = `Eres una profesora de inglés súper paciente, cálida y experta en fonética para hispanohablantes que NO saben nada de inglés.
Tu alumna está leyendo un texto en inglés en voz alta y el sistema transcribió su audio con reconocimiento de voz (ASR).
Debes responder SIEMPRE en formato JSON válido en español claro, motivador y sin tecnicismos lingüísticos difíciles.
REGLA CRÍTICA PARA LA GUÍA DE PRONUNCIACIÓN: NUNCA uses guiones (-) para separar sílabas ni mayúsculas mezcladas dentro de una palabra (PROHIBIDO escribir "BÉRT-dei" o "so-FÍ-as"). Usa español latinoamericano: NUNCA uses la "z" estilo España para la "th" del inglés (en Latinoamérica la "z" suena como "s"); usa "t" o "d" según corresponda (ej: "uit", "bértdei", "terd", "fort", "tri", "dat", "de"). Escribe cada palabra corrida y natural como español normal usando solo tildes donde va la fuerza (ej: "bértdei", "sáturdei", "sélebreit", "jaus").`;

  const userPrompt = `Analiza esta lectura y responde en JSON con la estructura exacta del ejemplo.

Texto esperado: "${alignment.expectedClean || expectedText}"
Lo que escuchó el ASR: "${transcribedText || '(silencio)'}"
Puntaje calculado por alineación de palabras: ${alignment.score}/100 (completitud: ${alignment.completeness}%, precisión: ${alignment.wordAccuracy}%)
Palabras con diferencias: ${JSON.stringify(problematic)}

Responde exactamente con este formato JSON:
{
  "adjustedScore": 85,
  "encouragingTitle": "¡Muy buen intento!",
  "summary": "Un resumen cálido de 2 frases en español explicando qué salió bien y qué mejorar.",
  "wordFeedback": [
    {
      "word": "birthday",
      "heard": "birtday",
      "phoneticEs": "bértdei",
      "tipEs": "Explicación sencilla en español latinoamericano de cómo pronunciarla mejor, sin guiones."
    }
  ],
  "nextStepTip": "Un consejo corto y práctico para el siguiente intento."
}`;

  try {
    const ai = await callDeepSeekJson({ systemPrompt, userPrompt, temperature: 0.3 });
    const rawScore = Number(ai?.adjustedScore);
    const minScore = Math.max(0, alignment.score - 12);
    const maxScore = Math.min(100, alignment.score + 12);
    const adjustedScore = Number.isFinite(rawScore)
      ? Math.max(minScore, Math.min(maxScore, Math.round(rawScore)))
      : alignment.score;

    return {
      adjustedScore,
      encouragingTitle:
        typeof ai?.encouragingTitle === 'string' && ai.encouragingTitle.trim()
          ? ai.encouragingTitle.trim()
          : fallback.encouragingTitle,
      summary:
        typeof ai?.summary === 'string' && ai.summary.trim()
          ? ai.summary.trim()
          : fallback.summary,
      wordFeedback: Array.isArray(ai?.wordFeedback)
        ? ai.wordFeedback.slice(0, 8).map((item) => ({
            word: String(item?.word || ''),
            heard: item?.heard ? String(item.heard) : '(no se escuchó)',
            phoneticEs: cleanSpanishPhonetic(String(item?.phoneticEs || '')),
            tipEs: String(item?.tipEs || ''),
          }))
        : fallback.wordFeedback,
      nextStepTip:
        typeof ai?.nextStepTip === 'string' && ai.nextStepTip.trim()
          ? ai.nextStepTip.trim()
          : fallback.nextStepTip,
    };
  } catch {
    return fallback;
  }
}

export function prepareScriptFallback({ title, rawText }) {
  const cleaned = String(rawText || '').trim();
  // Split while preserving parenthetical cues to attach as cueAfter / cueBefore
  const chunks = cleaned
    .split(/(?<=[.!?])\s+|(\([^)]+\))/)
    .map((s) => (s ? s.trim() : ''))
    .filter(Boolean);

  const segments = [];
  let pendingCueBefore = '';

  for (const chunk of chunks) {
    if (/^\([^)]+\)$/.test(chunk)) {
      const cueText = chunk.slice(1, -1).trim();
      if (segments.length > 0 && /pausa/i.test(cueText)) {
        segments[segments.length - 1].cueAfter = cueText;
        segments[segments.length - 1].pauseAfterSec = /breve/i.test(cueText) ? 0.8 : 1.2;
      } else {
        pendingCueBefore = pendingCueBefore ? `${pendingCueBefore} · ${cueText}` : cueText;
      }
      continue;
    }

    const text = stripStageDirections(chunk);
    if (!text) continue;

    // Split overly long sentences by comma/semicolon if > 22 words
    const wordsCount = text.split(/\s+/).length;
    const subParts =
      wordsCount > 22
        ? text.split(/(?<=[,;:])\s+/).filter(Boolean)
        : [text];

    subParts.forEach((partText, idx) => {
      const segNum = segments.length + 1;
      segments.push({
        id: `seg-${crypto.randomUUID().slice(0, 8)}`,
        order: segNum,
        title: `Parte ${segNum}`,
        text: partText,
        cueBefore: idx === 0 ? pendingCueBefore : '',
        cueAfter: '',
        pauseAfterSec: 0.45,
        phoneticEs: '',
        translationEs: '',
        tipsEs: [
          'Escucha primero el audio lento y haz clic en cualquier palabra si quieres practicarla sola.',
        ],
        words: [],
        takes: [],
        selectedTakeId: null,
      });
      if (idx === 0) pendingCueBefore = '';
    });
  }

  return {
    id: `proj-${crypto.randomUUID().slice(0, 8)}`,
    title: String(title || 'Nuevo guion de práctica').trim(),
    description: 'Guion dividido en partes cortas para practicar paso a paso.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    segments,
  };
}

export async function prepareScriptWithAI({ title, rawText }) {
  const cfg = getDeepSeekConfig();
  if (!cfg.hasApiKey) {
    return {
      project: prepareScriptFallback({ title, rawText }),
      usedAI: false,
    };
  }

  const systemPrompt = `Eres una profesora de inglés para principiantes hispanohablantes que NO saben inglés.
Debes dividir un texto en inglés en partes cortas y fáciles de leer (entre 6 y 18 palabras por parte), conservando EXACTAMENTE cada palabra inglesa original sin cambiarla ni omitirla.
Si el texto tiene indicaciones en español o entre paréntesis como (Pausa breve) o (Sonríe al hablar), NO las pongas en "text"; colócalas en "cueBefore" o "cueAfter" y ajusta "pauseAfterSec" (ej: 0.8 para pausa breve, 1.2 para pausa larga, 0.45 normal).
REGLA CRÍTICA PARA "phoneticEs": NUNCA separes sílabas con guiones (-) ni uses mayúsculas mezcladas dentro de una palabra (PROHIBIDO "so-FÍ-as" o "BÉRT-dei"). Usa español latinoamericano: NUNCA uses la "z" estilo España para la "th" del inglés (en Latinoamérica la "z" suena como "s"); usa "t" o "d" según corresponda (ej: "uit", "bértdei", "terd", "fort", "tri", "dat", "de"). Escribe cada palabra corrida y natural como español normal usando solo tildes donde va la fuerza (ej: "bértdei", "sáturdei", "sélebreit", "anfórchunetli") para que pueda leer de corrido sin pausar.
Responde SIEMPRE en JSON válido.`;

  const userPrompt = `Prepara este guion titulado "${title || 'Mi práctica en inglés'}":

"""
${rawText}
"""

Devuelve un JSON con exactamente esta estructura:
{
  "title": "Título bonito en español",
  "description": "Descripción corta en español",
  "segments": [
    {
      "title": "Parte 1 — Tema corto",
      "text": "Exact English words for this short part.",
      "cueBefore": "",
      "cueAfter": "Pausa breve",
      "pauseAfterSec": 0.8,
      "phoneticEs": "Pronunciación completa escrita corrida como español normal con tildes y sin guiones",
      "translationEs": "Traducción natural al español",
      "tipsEs": ["Consejo práctico 1 en español", "Consejo 2"],
      "words": [
        {
          "word": "birthday",
          "phoneticEs": "bértdei",
          "meaningEs": "cumpleaños",
          "tipEs": "Haz una 't' suavecita en la mitad rozando la lengua con los dientes."
        }
      ]
    }
  ]
}`;

  const ai = await callDeepSeekJson({ systemPrompt, userPrompt, temperature: 0.2 });
  const rawSegments = Array.isArray(ai?.segments) ? ai.segments : [];
  if (rawSegments.length === 0) {
    return {
      project: prepareScriptFallback({ title, rawText }),
      usedAI: false,
    };
  }

  const segments = rawSegments
    .filter((s) => typeof s?.text === 'string' && s.text.trim())
    .map((s, idx) => ({
      id: `seg-${crypto.randomUUID().slice(0, 8)}`,
      order: idx + 1,
      title: String(s.title || `Parte ${idx + 1}`).trim(),
      text: String(s.text).trim(),
      cueBefore: String(s.cueBefore || '').trim(),
      cueAfter: String(s.cueAfter || '').trim(),
      pauseAfterSec: Math.max(0, Math.min(3, Number(s.pauseAfterSec) || 0.45)),
      phoneticEs: cleanSpanishPhonetic(String(s.phoneticEs || '')),
      translationEs: String(s.translationEs || '').trim(),
      tipsEs: Array.isArray(s.tipsEs) ? s.tipsEs.map(String) : [],
      words: Array.isArray(s.words)
        ? s.words.map((w) => ({
            word: String(w?.word || ''),
            phoneticEs: cleanSpanishPhonetic(String(w?.phoneticEs || '')),
            meaningEs: String(w?.meaningEs || ''),
            tipEs: String(w?.tipEs || ''),
          }))
        : [],
      takes: [],
      selectedTakeId: null,
    }));

  return {
    project: {
      id: `proj-${crypto.randomUUID().slice(0, 8)}`,
      title: String(ai?.title || title || 'Mi práctica').trim(),
      description: String(ai?.description || 'Guion preparado con DeepSeek Flash 4.1.').trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      segments,
    },
    usedAI: true,
  };
}

export async function explainWordWithAI({ word, context = '' }) {
  const cleanWord = String(word || '').trim();
  if (!cleanWord) {
    throw new DeepSeekError('Falta la palabra a consultar.', 400, 'EMPTY_WORD');
  }

  const cacheKey = cleanWord
    .toLowerCase()
    .replace(/^[^a-zA-Z0-9'’]+|[^a-zA-Z0-9'’]+$/g, '');

  const cached = getCachedWord(cacheKey);
  if (cached) return cached;

  const cfg = getDeepSeekConfig();
  if (!cfg.hasApiKey) {
    return {
      word: cleanWord,
      phoneticEs: 'Escucha el audio',
      syllablesEs: cleanWord,
      meaningEs: 'Agrega tu DEEPSEEK_API_KEY en .env para ver la traducción y guía fonética de cualquier palabra.',
      tipEs: 'Pulsa el botón de altavoz para oír cómo suena en voz alta.',
      fromAI: false,
    };
  }

  const systemPrompt = `Eres una profesora de inglés para hispanohablantes que no saben nada de inglés.
Responde en JSON claro en español sin usar símbolos fonéticos complicados.
REGLA CRÍTICA: NUNCA uses guiones (-) para separar sílabas ni mayúsculas dentro de una palabra (PROHIBIDO "BÉRT-dei" o "an-FÓR-chu-net-li"). Usa español latinoamericano: NUNCA uses la "z" estilo España para la "th" del inglés (en Latinoamérica la "z" suena como "s"); usa "t" o "d" según corresponda (ej: "uit", "bértdei", "terd", "fort", "tri", "dat", "de"). Escribe la pronunciación como una sola palabra corrida con tilde en la vocal fuerte (ej: "bértdei", "anfórchunetli").`;

  const userPrompt = `Explica cómo pronunciar la palabra inglesa "${cleanWord}"${
    context ? ` dentro de la frase: "${context}"` : ''
  }.

Responde en JSON con este formato exacto:
{
  "word": "${cleanWord}",
  "phoneticEs": "pronunciación corrida en español con tilde y sin guiones",
  "meaningEs": "Significado en español",
  "tipEs": "Un consejo muy corto y amigable para que un hispanohablante la diga bien"
}`;

  const ai = await callDeepSeekJson({ systemPrompt, userPrompt, temperature: 0.2 });
  const result = {
    word: String(ai?.word || cleanWord),
    phoneticEs: cleanSpanishPhonetic(String(ai?.phoneticEs || '')),
    syllablesEs: '',
    meaningEs: String(ai?.meaningEs || ''),
    tipEs: String(ai?.tipEs || ''),
    fromAI: true,
  };

  if (cacheKey) {
    setCachedWord(cacheKey, result);
  }
  return result;
}
