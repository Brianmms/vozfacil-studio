import type {
  EvaluationResult,
  Project,
  ScriptSegment,
  VoiceId,
  WordExplanation,
} from '../types';
import { alignWords, type AlignmentResult } from '../shared/alignment';
import { cleanSpanishPhonetic } from '../shared/phonetics';
import { fixWavHeaderBytes } from '../shared/wavHeader';
import {
  addEvaluation,
  getCachedTts,
  getCachedWord,
  saveProject,
  setCachedTts,
  setCachedWord,
} from './localStore';
import { getDeepSeekSettings, type DeepSeekSettings } from './settings';
import { parseScriptText } from './scriptParser';

export class DeepSeekClientError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 500, code = 'DEEPSEEK_ERROR') {
    super(message);
    this.name = 'DeepSeekClientError';
    this.status = status;
    this.code = code;
  }
}

function requireDeepSeekSettings(override?: DeepSeekSettings): DeepSeekSettings {
  const cfg = override || getDeepSeekSettings();
  if (!cfg.apiKey.trim()) {
    throw new DeepSeekClientError(
      'Falta configurar tu API Key de DeepSeek. Pulsa "Configurar API Key" arriba para agregarla.',
      400,
      'API_KEY_MISSING'
    );
  }
  return cfg;
}

function createIdSuffix(len = 8): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, len);
  }
  return Math.random().toString(36).slice(2, 2 + len);
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
      return json?.error?.message || json?.message || text || `HTTP ${response.status}`;
    } catch {
      return text || `HTTP ${response.status}`;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

function formatDeepSeekHttpError(
  status: number,
  detail: string,
  action: string
): DeepSeekClientError {
  if (status === 401) {
    return new DeepSeekClientError(
      'Tu API Key de DeepSeek no es válida o fue revocada. Revísala en "Configurar API Key".',
      401,
      'UNAUTHORIZED'
    );
  }
  if (status === 402) {
    return new DeepSeekClientError(
      'Tu cuenta de DeepSeek no tiene saldo suficiente para esta petición.',
      402,
      'INSUFFICIENT_BALANCE'
    );
  }
  if (status === 429) {
    return new DeepSeekClientError(
      'DeepSeek limitó temporalmente las peticiones. Espera unos segundos e intenta de nuevo.',
      429,
      'RATE_LIMIT'
    );
  }
  return new DeepSeekClientError(
    `Error en ${action} (${status}): ${detail}`,
    status >= 400 && status < 500 ? status : 502,
    'DEEPSEEK_API_ERROR'
  );
}

function wrapFetchError(err: unknown, action: string): DeepSeekClientError {
  if (err instanceof DeepSeekClientError) return err;
  const detail = err instanceof Error ? err.message : 'Error de red';
  return new DeepSeekClientError(
    `No se pudo conectar con DeepSeek para ${action}. Revisa tu internet o la URL base (${detail}).`,
    0,
    'NETWORK_ERROR'
  );
}

function cleanJsonString(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function testDeepSeekConnection(
  settings: DeepSeekSettings
): Promise<{ ok: true; model: string }> {
  const cfg = requireDeepSeekSettings(settings);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'Reply OK' }],
        max_tokens: 8,
        thinking: { type: 'disabled' },
      }),
    });
  } catch (err) {
    throw wrapFetchError(err, 'probar la conexión');
  }

  if (!res.ok) {
    const detail = await parseErrorMessage(res);
    throw formatDeepSeekHttpError(res.status, detail, 'DeepSeek Chat');
  }

  return { ok: true, model: cfg.model };
}

async function callDeepSeekJson<T = Record<string, unknown>>(params: {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}): Promise<T> {
  const cfg = requireDeepSeekSettings();
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        temperature: params.temperature ?? 0.25,
      }),
    });
  } catch (err) {
    throw wrapFetchError(err, 'consultar la IA');
  }

  if (!res.ok) {
    const detail = await parseErrorMessage(res);
    throw formatDeepSeekHttpError(res.status, detail, 'DeepSeek Chat');
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new DeepSeekClientError('DeepSeek devolvió una respuesta vacía.', 502, 'EMPTY_RESPONSE');
  }

  try {
    return JSON.parse(cleanJsonString(content)) as T;
  } catch {
    throw new DeepSeekClientError(
      'DeepSeek no devolvió un JSON válido.',
      502,
      'INVALID_JSON_RESPONSE'
    );
  }
}

export async function synthesizeSpeechClient(params: {
  text: string;
  voiceId?: VoiceId;
}): Promise<Blob> {
  const cleanText = String(params.text || '').trim();
  if (!cleanText) {
    throw new DeepSeekClientError(
      'El texto para generar audio no puede estar vacío.',
      400,
      'EMPTY_TEXT'
    );
  }

  const safeVoice: VoiceId = params.voiceId === 'tide' ? 'tide' : 'stella';
  const cached = await getCachedTts(safeVoice, cleanText);
  if (cached) {
    const rawBytes = new Uint8Array(await cached.arrayBuffer());
    const fixedBytes = fixWavHeaderBytes(rawBytes);
    const fixedBlob = new Blob([toArrayBuffer(fixedBytes)], { type: 'audio/wav' });
    if (fixedBytes.byteLength !== rawBytes.byteLength || fixedBytes[4] !== rawBytes[4]) {
      await setCachedTts(safeVoice, cleanText, fixedBlob);
    }
    return fixedBlob;
  }

  const cfg = requireDeepSeekSettings();
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/v1/tools/tts`, {
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
  } catch (err) {
    throw wrapFetchError(err, 'generar audio guía');
  }

  if (!res.ok) {
    const detail = await parseErrorMessage(res);
    throw formatDeepSeekHttpError(res.status, detail, 'DeepSeek TTS');
  }

  const arrayBuffer = await res.arrayBuffer();
  const fixedBytes = fixWavHeaderBytes(new Uint8Array(arrayBuffer));
  const wavBlob = new Blob([toArrayBuffer(fixedBytes)], { type: 'audio/wav' });
  if (wavBlob.size > 0) {
    await setCachedTts(safeVoice, cleanText, wavBlob).catch(() => {});
  }
  return wavBlob;
}

export async function transcribeAudioBlobsClient(
  wavBlobs: Blob[]
): Promise<{ text: string; durationMs: number }> {
  const cfg = requireDeepSeekSettings();
  if (!Array.isArray(wavBlobs) || wavBlobs.length === 0) {
    throw new DeepSeekClientError('No se recibió ningún archivo de audio.', 400, 'NO_AUDIO');
  }

  const parts: string[] = [];
  let totalDurationMs = 0;

  for (let i = 0; i < wavBlobs.length; i++) {
    const form = new FormData();
    form.append('file', wavBlobs[i], `chunk-${i + 1}.wav`);

    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/v1/tools/asr`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: form,
      });
    } catch (err) {
      throw wrapFetchError(err, 'transcribir el audio');
    }

    if (!res.ok) {
      const detail = await parseErrorMessage(res);
      throw formatDeepSeekHttpError(res.status, detail, 'DeepSeek ASR');
    }

    const json = (await res.json()) as { text?: string; duration_ms?: number };
    if (json?.text) parts.push(String(json.text).trim());
    if (typeof json?.duration_ms === 'number') totalDurationMs += json.duration_ms;
  }

  return {
    text: parts.join(' ').replace(/\s+/g, ' ').trim(),
    durationMs: totalDurationMs,
  };
}

function buildFallbackFeedback(alignment: AlignmentResult) {
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

interface AiFeedbackJson {
  adjustedScore?: number;
  encouragingTitle?: string;
  summary?: string;
  wordFeedback?: Array<{
    word?: string;
    heard?: string;
    phoneticEs?: string;
    tipEs?: string;
  }>;
  nextStepTip?: string;
}

export async function generatePronunciationFeedbackClient(params: {
  expectedText: string;
  transcribedText: string;
  alignment: AlignmentResult;
}) {
  const fallback = buildFallbackFeedback(params.alignment);
  const cfg = getDeepSeekSettings();
  if (!cfg.apiKey) {
    return fallback;
  }

  const problematic = params.alignment.words
    .filter((w) => w.status !== 'correct')
    .slice(0, 12)
    .map((w) => ({ expected: w.expected, heard: w.heard, status: w.status }));

  const systemPrompt = `Eres una profesora de inglés súper paciente, cálida y experta en fonética para hispanohablantes que NO saben nada de inglés.
Tu alumna está leyendo un texto en inglés en voz alta y el sistema transcribió su audio con reconocimiento de voz (ASR).
Debes responder SIEMPRE en formato JSON válido en español claro, motivador y sin tecnicismos lingüísticos difíciles.
REGLA CRÍTICA PARA LA GUÍA DE PRONUNCIACIÓN: NUNCA uses guiones (-) para separar sílabas ni mayúsculas mezcladas dentro de una palabra (PROHIBIDO escribir "BÉRT-dei" o "so-FÍ-as"). Usa español latinoamericano: NUNCA uses la "z" estilo España para la "th" del inglés (en Latinoamérica la "z" suena como "s"); usa "t" o "d" según corresponda (ej: "uit", "bértdei", "terd", "fort", "tri", "dat", "de"). Escribe cada palabra corrida y natural como español normal usando solo tildes donde va la fuerza (ej: "bértdei", "sáturdei", "sélebreit", "jaus").`;

  const userPrompt = `Analiza esta lectura y responde en JSON con la estructura exacta del ejemplo.

Texto esperado: "${params.alignment.expectedClean || params.expectedText}"
Lo que escuchó el ASR: "${params.transcribedText || '(silencio)'}"
Puntaje calculado por alineación de palabras: ${params.alignment.score}/100 (completitud: ${params.alignment.completeness}%, precisión: ${params.alignment.wordAccuracy}%)
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
    const ai = await callDeepSeekJson<AiFeedbackJson>({
      systemPrompt,
      userPrompt,
      temperature: 0.3,
    });
    const rawScore = Number(ai?.adjustedScore);
    const minScore = Math.max(0, params.alignment.score - 12);
    const maxScore = Math.min(100, params.alignment.score + 12);
    const adjustedScore = Number.isFinite(rawScore)
      ? Math.max(minScore, Math.min(maxScore, Math.round(rawScore)))
      : params.alignment.score;

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

export async function evaluateAudioClient(params: {
  wavChunks: Blob[];
  expectedText: string;
  ignoreParentheses?: boolean;
  saveHistory?: boolean;
}): Promise<EvaluationResult> {
  const expectedText = String(params.expectedText || '').trim();
  if (!expectedText) {
    throw new DeepSeekClientError('Falta el texto esperado en inglés.', 400, 'EMPTY_TEXT');
  }
  if (!params.wavChunks || params.wavChunks.length === 0) {
    throw new DeepSeekClientError('Falta el audio para evaluar.', 400, 'NO_AUDIO');
  }

  const ignoreParentheses = params.ignoreParentheses !== false;
  const asr = await transcribeAudioBlobsClient(params.wavChunks);
  const alignment = alignWords(expectedText, asr.text, { ignoreParentheses });
  const feedback = await generatePronunciationFeedbackClient({
    expectedText,
    transcribedText: asr.text,
    alignment,
  });

  const payload: EvaluationResult = {
    id: `eval-${createIdSuffix(12)}`,
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

  if (params.saveHistory) {
    await addEvaluation(payload);
  }

  return payload;
}

export function prepareScriptFallback(params: {
  title: string;
  rawText: string;
}): Project {
  const parsed = parseScriptText(params.rawText);
  const segments: ScriptSegment[] = parsed.map((item, index) => ({
    id: `seg-${createIdSuffix(8)}`,
    order: index + 1,
    title: item.title,
    speaker: item.speaker,
    text: item.text,
    cueBefore: item.cueBefore,
    cueAfter: item.cueAfter,
    pauseAfterSec: item.pauseAfterSec,
    phoneticEs: item.phoneticEs,
    translationEs: item.translationEs,
    tipsEs: item.tipsEs,
    words: item.words,
    takes: [],
    selectedTakeId: null,
  }));

  if (segments.length === 0) {
    const fallbackText = String(params.rawText || '').trim();
    if (fallbackText) {
      segments.push({
        id: `seg-${createIdSuffix(8)}`,
        order: 1,
        title: 'Parte 1',
        speaker: '',
        text: fallbackText,
        cueBefore: '',
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
    }
  }

  return {
    id: `proj-${createIdSuffix(8)}`,
    title: String(params.title || 'Nuevo guion de práctica').trim(),
    description: 'Guion dividido en partes cortas para practicar paso a paso.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    segments,
  };
}

interface AiPreparedScriptJson {
  title?: string;
  description?: string;
  segments?: Array<{
    title?: string;
    speaker?: string;
    speakerPhoneticEs?: string;
    text?: string;
    cueBefore?: string;
    cueAfter?: string;
    pauseAfterSec?: number;
    phoneticEs?: string;
    translationEs?: string;
    tipsEs?: string[];
    words?: Array<{
      word?: string;
      phoneticEs?: string;
      meaningEs?: string;
      tipEs?: string;
    }>;
  }>;
}

export async function prepareScriptClient(params: {
  title: string;
  rawText: string;
  save?: boolean;
}): Promise<{ project: Project; usedAI: boolean }> {
  const cfg = getDeepSeekSettings();
  if (!cfg.apiKey) {
    const project = prepareScriptFallback({
      title: params.title,
      rawText: params.rawText,
    });
    return {
      project: params.save ? await saveProject(project) : project,
      usedAI: false,
    };
  }

  const systemPrompt = `Eres una profesora de inglés para principiantes hispanohablantes que NO saben inglés.
Debes dividir un texto en inglés en partes cortas y fáciles de leer (entre 6 y 18 palabras por parte), conservando EXACTAMENTE cada palabra inglesa original sin cambiarla ni omitirla.
Si el texto tiene indicaciones en español o entre paréntesis como (Pausa breve) o (Sonríe al hablar), NO las pongas en "text"; colócalas en "cueBefore" o "cueAfter" y ajusta "pauseAfterSec" (ej: 0.8 para pausa breve, 1.2 para pausa larga, 0.45 normal).
Si el texto es un DIÁLOGO con hablantes (ej. "Tú (Cliente): ..." o "Mesero: ..."), detecta el hablante, TRADÚCELO al inglés en "speaker" (Cliente→Client, Mesero→Waiter, Abuelo→Grandpa, etc.) y pon su pronunciación en español latinoamericano en "speakerPhoneticEs" (ej. "claient", "uéirer", "gránpa"). NUNCA incluyas el nombre del hablante ni el prefijo "Tú (Cliente):" dentro de "text".
NUNCA pongas en "text" encabezados, pasos ni instrucciones no inglesas. Los corchetes como "[Paso 1: ...]" o "[Closing]" son pasos/cues: van en "cueBefore"; las indicaciones entre paréntesis como "(Pausa breve)" o "(Haces una pausa)" van en "cueAfter" y ajustan "pauseAfterSec". Ignora por completo cualquier línea que no esté en inglés.
REGLA CRÍTICA PARA "phoneticEs": NUNCA separes sílabas con guiones (-) ni uses mayúsculas mezcladas dentro de una palabra (PROHIBIDO "so-FÍ-as" o "BÉRT-dei"). Usa español latinoamericano: NUNCA uses la "z" estilo España para la "th" del inglés (en Latinoamérica la "z" suena como "s"); usa "t" o "d" según corresponda (ej: "uit", "bértdei", "terd", "fort", "tri", "dat", "de"). Escribe cada palabra corrida y natural como español normal usando solo tildes donde va la fuerza (ej: "bértdei", "sáturdei", "sélebreit", "anfórchunetli") para que pueda leer de corrido sin pausar.
Responde SIEMPRE en JSON válido.`;

  const userPrompt = `Prepara este guion titulado "${params.title || 'Mi práctica en inglés'}":

"""
${params.rawText}
"""

Devuelve un JSON con exactamente esta estructura:
{
  "title": "Título bonito en español",
  "description": "Descripción corta en español",
  "segments": [
    {
      "title": "Parte 1 — Tema corto",
      "speaker": "Rol en inglés (Client, Waiter...) o cadena vacía",
      "speakerPhoneticEs": "Pronunciación del rol en español (claient, uéirer...) o cadena vacía",
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

  const ai = await callDeepSeekJson<AiPreparedScriptJson>({
    systemPrompt,
    userPrompt,
    temperature: 0.2,
  });

  const rawSegments = Array.isArray(ai?.segments) ? ai.segments : [];
  if (rawSegments.length === 0) {
    const project = prepareScriptFallback({
      title: params.title,
      rawText: params.rawText,
    });
    return {
      project: params.save ? await saveProject(project) : project,
      usedAI: false,
    };
  }

  const segments: ScriptSegment[] = rawSegments
    .filter((s) => typeof s?.text === 'string' && s.text.trim())
    .map((s, idx) => ({
      id: `seg-${createIdSuffix(8)}`,
      order: idx + 1,
      title: String(s.title || `Parte ${idx + 1}`).trim(),
      speaker: String(s.speaker || '').trim(),
      speakerPhoneticEs: String(s.speakerPhoneticEs || '').trim(),
      text: String(s.text).trim().replace(/^["'“”«»]+|["'“”«»]+$/g, '').trim(),
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

  const prepared: Project = {
    id: `proj-${createIdSuffix(8)}`,
    title: String(ai?.title || params.title || 'Mi práctica').trim(),
    description: String(ai?.description || 'Guion preparado con DeepSeek Flash 4.1.').trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    segments,
  };

  return {
    project: params.save ? await saveProject(prepared) : prepared,
    usedAI: true,
  };
}

export async function explainWordClient(params: {
  word: string;
  context?: string;
}): Promise<WordExplanation> {
  const cleanWord = String(params.word || '').trim();
  if (!cleanWord) {
    throw new DeepSeekClientError('Falta la palabra a consultar.', 400, 'EMPTY_WORD');
  }

  const cacheKey = cleanWord
    .toLowerCase()
    .replace(/^[^a-zA-Z0-9'’]+|[^a-zA-Z0-9'’]+$/g, '');

  if (cacheKey) {
    const cached = await getCachedWord(cacheKey);
    if (cached) return cached;
  }

  const cfg = getDeepSeekSettings();
  if (!cfg.apiKey) {
    return {
      word: cleanWord,
      phoneticEs: 'Escucha el audio',
      syllablesEs: cleanWord,
      meaningEs:
        'Pulsa "Configurar API Key" arriba y agrega tu clave de DeepSeek para ver la traducción y guía fonética de cualquier palabra.',
      tipEs: 'Pulsa el botón de altavoz para oír cómo suena en voz alta.',
      fromAI: false,
    };
  }

  const systemPrompt = `Eres una profesora de inglés para hispanohablantes que no saben nada de inglés.
Responde en JSON claro en español sin usar símbolos fonéticos complicados.
REGLA CRÍTICA: NUNCA uses guiones (-) para separar sílabas ni mayúsculas dentro de una palabra (PROHIBIDO "BÉRT-dei" o "an-FÓR-chu-net-li"). Usa español latinoamericano: NUNCA uses la "z" estilo España para la "th" del inglés (en Latinoamérica la "z" suena como "s"); usa "t" o "d" según corresponda (ej: "uit", "bértdei", "terd", "fort", "tri", "dat", "de"). Escribe la pronunciación como una sola palabra corrida con tilde en la vocal fuerte (ej: "bértdei", "anfórchunetli").`;

  const userPrompt = `Explica cómo pronunciar la palabra inglesa "${cleanWord}"${
    params.context ? ` dentro de la frase: "${params.context}"` : ''
  }.

Responde en JSON con este formato exacto:
{
  "word": "${cleanWord}",
  "phoneticEs": "pronunciación corrida en español con tilde y sin guiones",
  "meaningEs": "Significado en español",
  "tipEs": "Un consejo muy corto y amigable para que un hispanohablante la diga bien"
}`;

  const ai = await callDeepSeekJson<{
    word?: string;
    phoneticEs?: string;
    meaningEs?: string;
    tipEs?: string;
  }>({
    systemPrompt,
    userPrompt,
    temperature: 0.2,
  });

  const result: WordExplanation = {
    word: String(ai?.word || cleanWord),
    phoneticEs: cleanSpanishPhonetic(String(ai?.phoneticEs || '')),
    syllablesEs: '',
    meaningEs: String(ai?.meaningEs || ''),
    tipEs: String(ai?.tipEs || ''),
    fromAI: true,
  };

  if (cacheKey) {
    await setCachedWord(cacheKey, result).catch(() => {});
  }
  return result;
}
