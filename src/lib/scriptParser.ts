import type { WordGuide } from '../types';

export interface ParsedSegment {
  title: string;
  speaker: string;
  text: string;
  cueBefore: string;
  cueAfter: string;
  pauseAfterSec: number;
  phoneticEs: string;
  translationEs: string;
  tipsEs: string[];
  words: WordGuide[];
}

export interface PlaceholderProfile {
  name?: string;
  age?: string;
  grade?: string;
}

const DEFAULT_TIP =
  'Escucha primero el audio lento y haz clic en cualquier palabra si quieres practicarla sola.';

const SPANISH_HINTS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'que',
  'y', 'e', 'o', 'u', 'en', 'por', 'para', 'con', 'sin', 'tu', 'tú', 'muy',
  'más', 'mas', 'como', 'pero', 'es', 'son', 'está', 'estan', 'están', 'hola',
  'gracias', 'paso', 'pasos', 'cliente', 'mesero', 'mesera', 'camarero',
  'pausa', 'breve', 'sonríe', 'sonrie', 'voz', 'tono', 'nota', 'ejemplo',
  'favorito', 'favorita', 'dime', 'di', 'lee', 'escucha', 'recuerda',
  'practica', 'actúa', 'actua', 'haz', 'aquí', 'aqui',
]);

function countWords(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function looksMostlySpanish(value: string): boolean {
  const words = value
    .toLowerCase()
    .replace(/[.,;:!?¿¡"“”«»]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  let hits = 0;
  for (const word of words) {
    if (SPANISH_HINTS.has(word)) hits += 1;
  }
  return hits >= 2 && hits / words.length >= 0.28;
}

function cleanRole(raw: string): string {
  return raw
    .replace(/[()\[\]]/g, '')
    .replace(/^\s*t[uú]\s*/i, '')
    .trim();
}

function isStepBracket(inner: string): boolean {
  return /^\s*(paso|step|escena|scene|parte|part|closing|intro|introducci[oó]n|introduction|final|cierre)\b/i.test(
    inner
  );
}

function normalizePlaceholderKey(inner: string): string {
  return inner
    .replace(/[,;]?\s*por\s+ejemplo\s*:.*$/i, '')
    .trim()
    .toLowerCase();
}

export interface PlaceholderToken {
  key: string;
  label: string;
  defaultValue: string;
}

/**
 * Finds every inline [placeholder] in the text (e.g. [tu nombre], [food],
 * [places]) and returns one field per unique placeholder. Whole-line step
 * headings like [Paso 1: ...] are not treated as placeholders.
 */
export function extractPlaceholders(rawText: string): PlaceholderToken[] {
  const lines = String(rawText || '').replace(/\r\n?/g, '\n').split('\n');
  const seen = new Set<string>();
  const tokens: PlaceholderToken[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const wholeLine = line.match(/^\[(.+)\]$/);
    if (wholeLine && isStepBracket(wholeLine[1])) continue;

    for (const match of line.matchAll(/\[([^\]]+)\]/g)) {
      const inner = match[1].trim();
      if (!inner || isStepBracket(inner)) continue;
      const key = normalizePlaceholderKey(inner);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const exampleMatch = inner.match(/por\s+ejemplo\s*:\s*(.+)$/i);
      tokens.push({
        key,
        label: inner.replace(/[,;]?\s*por\s+ejemplo\s*:.*$/i, '').trim() || key,
        defaultValue: exampleMatch ? exampleMatch[1].trim() : '',
      });
    }
  }

  return tokens;
}

/**
 * Replaces each inline [placeholder] with the matching value. Falls back to
 * the "por ejemplo: X" example, and leaves step headings untouched.
 */
export function applyPlaceholderValues(
  text: string,
  values: Record<string, string>
): string {
  return String(text || '').replace(/\[([^\]]+)\]/g, (full, innerRaw: string) => {
    const inner = String(innerRaw).trim();
    if (!inner || isStepBracket(inner)) return full;
    const key = normalizePlaceholderKey(inner);
    const provided = String(values[key] ?? '').trim();
    if (provided) return provided;
    const exampleMatch = inner.match(/por\s+ejemplo\s*:\s*(.+)$/i);
    if (exampleMatch) return exampleMatch[1].trim();
    return full;
  });
}

/** Backward-compatible helper for the classic name/age/grade profile. */
export function applyPlaceholders(text: string, profile: PlaceholderProfile = {}): string {
  const values: Record<string, string> = {};
  if (profile.name) values['tu nombre'] = profile.name;
  if (profile.age) values['tu edad'] = profile.age;
  if (profile.grade) values['tu grado'] = profile.grade;
  return applyPlaceholderValues(text, values);
}

/**
 * Deterministic, line-based parser for practice scripts.
 * Handles dialogue roles ("Tú (Cliente): ..."), step headings ("[Paso 1: ...]"),
 * stage directions "(...)", quotes, and drops Spanish-only instruction lines.
 * Narrative text without any of those markers is parsed the same as before.
 */
export function parseScriptText(rawText: string): ParsedSegment[] {
  const lines = String(rawText || '').replace(/\r\n?/g, '\n').split('\n');
  const segments: ParsedSegment[] = [];
  let pendingCue = '';

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    // Whole-line bracket/parenthetical -> step or stage cue.
    const wholeLine = line.match(/^\[(.+)\]$/) || line.match(/^\((.+)\)$/);
    if (wholeLine) {
      const inner = wholeLine[1].trim();
      if (inner) {
        pendingCue = pendingCue ? `${pendingCue} · ${inner}` : inner;
      }
      continue;
    }

    // Speaker prefix: "Tú (Cliente): ..." or "Cliente: ...".
    let speaker = '';
    let rest = line;
    const roleWithParentheses = line.match(
      /^\s*(?:t[uú]|yo|you)\s*\(([^)]+)\)\s*:\s*(.*)$/i
    );
    if (roleWithParentheses) {
      speaker = cleanRole(roleWithParentheses[1]);
      rest = roleWithParentheses[2];
    } else {
      const genericRole = line.match(
        /^\s*([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ .]{0,18}?)\s*:\s*(.+)$/
      );
      if (genericRole && !/[.!?]/.test(genericRole[1]) && countWords(genericRole[1]) <= 3) {
        speaker = cleanRole(genericRole[1]);
        rest = genericRole[2];
      }
    }

    // Remaining parentheticals are stage directions (pauses, tone, acting).
    const stageCues: string[] = [];
    rest = rest.replace(/\(([^)]*)\)/g, (_match, cue: string) => {
      const value = String(cue).trim();
      if (value) stageCues.push(value);
      return ' ';
    });
    // Any leftover inline bracket placeholder is not spoken.
    rest = rest.replace(/\[[^\]]*\]/g, ' ');
    rest = rest
      .replace(/["“”«»]/g, '')
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/([.,;:!?])\1+/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (!rest) continue;

    // Spanish-only instruction line -> cue, not practice text.
    if (looksMostlySpanish(rest)) {
      pendingCue = pendingCue ? `${pendingCue} · ${rest}` : rest;
      continue;
    }

    let pauseAfterSec = 0.45;
    let cueAfter = '';
    for (const cue of stageCues) {
      if (/pausa|pause/i.test(cue)) {
        pauseAfterSec = /larga|long/i.test(cue) ? 1.2 : 0.8;
      }
      cueAfter = cueAfter ? `${cueAfter} · ${cue}` : cue;
    }

    const wordCount = rest.split(/\s+/).filter(Boolean).length;
    const sentenceParts =
      wordCount > 22
        ? rest
            .split(/(?<=[.!?])\s+/)
            .map((part) => part.trim())
            .filter(Boolean)
        : [rest];
    const parts = sentenceParts.length > 0 ? sentenceParts : [rest];

    parts.forEach((partText, partIdx) => {
      const order = segments.length + 1;
      segments.push({
        title: `Parte ${order}`,
        speaker,
        text: partText,
        cueBefore: partIdx === 0 ? pendingCue : '',
        cueAfter: partIdx === parts.length - 1 ? cueAfter : '',
        pauseAfterSec,
        phoneticEs: '',
        translationEs: '',
        tipsEs: [DEFAULT_TIP],
        words: [],
      });
    });
    pendingCue = '';
  }

  return segments;
}

/**
 * Extracts only the English practice text from a raw script (drops speaker
 * roles, step headings, stage directions and Spanish instructions) so the
 * evaluator compares the recording against clean text.
 */
export function cleanExpectedText(rawText: string): string {
  const segments = parseScriptText(rawText);
  const joined = segments
    .map((segment) => segment.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (joined) return joined;
  return String(rawText || '').replace(/\s+/g, ' ').trim();
}
