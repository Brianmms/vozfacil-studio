import test from 'node:test';
import assert from 'node:assert/strict';
import { alignWords, stripStageDirections, normalizeWord } from './alignment.js';
import { fixWavHeader } from './deepseek.js';
import { cleanSpanishPhonetic } from './phonetics.js';
import { createSofiaSeedProject, SOFIA_FULL_RAW_TEXT } from '../data/sofiaScript.js';

test('stripStageDirections removes parenthetical acting and pause cues', () => {
  const input = 'Hello world.(Pausa breve) How are you?(Sonríe al hablar) Fine!';
  assert.equal(stripStageDirections(input), 'Hello world. How are you? Fine!');
});

test('normalizeWord handles accents, curly quotes, contractions and numbers', () => {
  assert.equal(normalizeWord('Sofia’s'), 'sofias');
  assert.equal(normalizeWord('Tomás!'), 'tomas');
  assert.equal(normalizeWord('Julián,'), 'julian');
  assert.equal(normalizeWord('Mrs.'), 'mrs');
  assert.equal(normalizeWord('eleventh'), '11th');
  assert.equal(normalizeWord("can't."), 'cant');
});

test('alignWords achieves 100% on natural spoken equivalents', () => {
  const expected = 'It\'s on Saturday at my house at 3 PM. "Wanna come to my party?" Mrs. Ruiz smiled.';
  const heard = 'It is on Saturday at my house at three p.m. want to come to my party Missus Ruiz smiled';

  const result = alignWords(expected, heard);
  assert.equal(result.score, 100);
  assert.equal(result.completeness, 100);
  assert.ok(result.words.every((w) => w.status === 'correct'));
});

test('alignWords ignores stage directions when ignoreParentheses=true', () => {
  const expected = '(Voz elegante y pausada)"Dear Grandma, you are cordially invited."(Pausa)';
  const heard = 'Dear Grandma you are cordially invited';

  const result = alignWords(expected, heard, { ignoreParentheses: true });
  assert.equal(result.score, 100);
  assert.equal(result.words.length, 6);
});

test('alignWords detects missing and close/incorrect words accurately', () => {
  const expected = 'Sofia wanted to celebrate with a big party at her house';
  const heard = 'Sofia wanted to celebrate a big party in her horse';

  const result = alignWords(expected, heard);
  assert.ok(result.score < 95 && result.score > 50);

  const missingWith = result.words.find((w) => w.expected.toLowerCase() === 'with');
  assert.equal(missingWith?.status, 'missing');

  const closeHouse = result.words.find((w) => w.expected.toLowerCase() === 'house');
  assert.ok(closeHouse?.status === 'close' || closeHouse?.status === 'incorrect');
});

test('sofiaScript seed project preserves 100% of the exact English story text across 17 parts', () => {
  const project = createSofiaSeedProject();
  assert.equal(project.segments.length, 17);

  const normalizeSpaces = (s) =>
    stripStageDirections(s)
      .replace(/[’‘]/g, "'")
      .replace(/([?.!])"([A-Z])/g, '$1" $2')
      .replace(/\s+/g, ' ')
      .replace(/:\s+"/g, ':"')
      .trim();

  const joinedSegments = normalizeSpaces(project.segments.map((s) => s.text).join(' '));
  const rawCleaned = normalizeSpaces(SOFIA_FULL_RAW_TEXT);

  assert.equal(joinedSegments, rawCleaned);
});

test('fixWavHeader repairs streaming 0xFFFFFFFF RIFF and data chunk sizes', () => {
  const buf = Buffer.alloc(44 + 100);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(0xffffffff, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(0xffffffff, 40);

  const fixed = fixWavHeader(buf);
  assert.equal(fixed.readUInt32LE(4), 144 - 8);
  assert.equal(fixed.readUInt32LE(40), 100);
});

test('cleanSpanishPhonetic removes syllable hyphens and mixed uppercase breaks', () => {
  assert.equal(
    cleanSpanishPhonetic('so-FÍ-as i-LÉ-vent BÉRT-dei'),
    'Sofías ilévent bértdei'
  );
  assert.equal(cleanSpanishPhonetic('an-FÓR-chu-net-li'), 'anfórchunetli');
  assert.equal(cleanSpanishPhonetic('in - vi - TÉI - shons'), 'invitéishons');
});

test('sofiaScript phonetic guides have zero syllable hyphens across all 17 parts', () => {
  const project = createSofiaSeedProject();
  for (const seg of project.segments) {
    assert.ok(seg.phoneticEs.length > 0, `Missing phoneticEs in ${seg.id}`);
    assert.equal(
      seg.phoneticEs.includes('-'),
      false,
      `Found hyphen in segment phoneticEs (${seg.id}): ${seg.phoneticEs}`
    );
    for (const wordItem of seg.words) {
      assert.equal(
        wordItem.phoneticEs.includes('-'),
        false,
        `Found hyphen in word phoneticEs (${seg.id}/${wordItem.word}): ${wordItem.phoneticEs}`
      );
    }
  }
});

test('sofiaScript uses Latin American Spanish phonetics without Spain-z spellings', () => {
  const project = createSofiaSeedProject();
  const forbidden = /\b(uiz|bérzdei|zerd|forz|zri)\b/i;

  for (const seg of project.segments) {
    assert.equal(
      forbidden.test(seg.phoneticEs),
      false,
      `Found Spain-z phonetic in ${seg.id}: ${seg.phoneticEs}`
    );
    for (const tip of seg.tipsEs || []) {
      assert.equal(
        forbidden.test(tip),
        false,
        `Found Spain-z phonetic in tip of ${seg.id}: ${tip}`
      );
    }
    for (const wordItem of seg.words || []) {
      assert.equal(
        forbidden.test(wordItem.phoneticEs),
        false,
        `Found Spain-z phonetic in word ${seg.id}/${wordItem.word}: ${wordItem.phoneticEs}`
      );
    }
  }

  const seg01 = project.segments.find((s) => s.id === 'sofia-seg-01');
  assert.ok(seg01);
  assert.ok(seg01.phoneticEs.includes('bértdei'));
  assert.ok(seg01.phoneticEs.includes('uit'));
  assert.equal(seg01.words.find((w) => w.word === 'with')?.phoneticEs, 'uit');

  const seg08 = project.segments.find((s) => s.id === 'sofia-seg-08');
  assert.ok(seg08);
  assert.ok(seg08.phoneticEs.includes('Ruiz'));
});
