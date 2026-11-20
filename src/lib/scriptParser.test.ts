import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScriptText,
  applyPlaceholders,
  applyPlaceholderValues,
  extractPlaceholders,
  cleanExpectedText,
} from './scriptParser.ts';

test('detecta roles de diálogo y los separa del texto', () => {
  const segs = parseScriptText(
    'Tú (Cliente): "Hello, do you have a table?"\nTú (Mesero): "Yes, right this way."'
  );
  assert.equal(segs.length, 2);
  assert.equal(segs[0].speaker, 'Cliente');
  assert.equal(segs[0].text, 'Hello, do you have a table?');
  assert.equal(segs[1].speaker, 'Mesero');
  assert.equal(segs[1].text, 'Yes, right this way.');
});

test('trata corchetes como pasos/cues y no como texto hablado', () => {
  const segs = parseScriptText('[Paso 1: Enter the restaurant]\nTú (Cliente): "Hello"');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].cueBefore, 'Paso 1: Enter the restaurant');
  assert.equal(segs[0].text, 'Hello');
});

test('descarta instrucciones en español', () => {
  const segs = parseScriptText('Practica esta frase con calma\nHello, how are you?');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'Hello, how are you?');
});

test('resuelve placeholders con el perfil', () => {
  const filled = applyPlaceholders(
    'My name is [tu nombre], I am [tu edad] and I am in grade [tu grado, por ejemplo: 9th].',
    { name: 'Sara', age: '15', grade: '9th' }
  );
  assert.match(filled, /Sara/);
  assert.match(filled, /15/);
  assert.match(filled, /9th/);
  assert.doesNotMatch(filled, /\[/);
});

test('resuelve placeholders inline con "por ejemplo"', () => {
  const filled = applyPlaceholders('Can I have [tu plato, por ejemplo: a burger], please?');
  assert.equal(filled, 'Can I have a burger, please?');
});

test('limpia comillas y puntuación duplicada', () => {
  const segs = parseScriptText('Tú (Mesero): "Sure! Coming right up." (Haces una pausa).');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'Sure! Coming right up.');
  assert.equal(segs[0].cueAfter, 'Haces una pausa');
});

test('texto narrativo sin roles se conserva', () => {
  const segs = parseScriptText('Sofia wanted to celebrate with a big party at her house.');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].speaker, '');
  assert.equal(segs[0].text, 'Sofia wanted to celebrate with a big party at her house.');
});

test('cleanExpectedText deja solo el inglés (sin roles, pasos ni español)', () => {
  const raw = '[Paso 1: Enter]\nTú (Cliente): "Hello, table?"\nTú (Mesero): "Sure!"';
  assert.equal(cleanExpectedText(raw), 'Hello, table? Sure!');
});

test('extrae placeholders dinámicos y excluye pasos', () => {
  const raw = '[Paso 1: Enter]\nHello [tu nombre], I want [food] in [places].';
  const tokens = extractPlaceholders(raw);
  assert.deepEqual(
    tokens.map((token) => token.key),
    ['tu nombre', 'food', 'places']
  );
});

test('aplica valores dinámicos y deja los pasos intactos', () => {
  const raw = '[Paso 1: Enter]\nHello [tu nombre], I want [food].';
  const out = applyPlaceholderValues(raw, { 'tu nombre': 'Sara', food: 'pizza' });
  assert.match(out, /\[Paso 1: Enter\]/);
  assert.match(out, /Hello Sara, I want pizza\./);
});
