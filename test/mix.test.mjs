import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mix = require('../src/renderer/mix.js');

function f32(values) {
  return Float32Array.from(values);
}

test('toInt16 ограничивает и масштабирует сэмплы', () => {
  assert.equal(mix.toInt16(0), 0);
  assert.equal(mix.toInt16(1), 32767);
  assert.equal(mix.toInt16(-1), -32767);
  assert.equal(mix.toInt16(2), 32767);
  assert.equal(mix.toInt16(-5), -32767);
  assert.equal(mix.toInt16(0.5), 16384);
});

test('mix: микрофон по центру, компьютер в стерео', () => {
  const out = mix.mixBlock({
    mode: 'mix',
    mic: f32([0.5, 0.5]),
    sysL: f32([0.25, 0]),
    sysR: f32([-0.25, 0]),
    frames: 2
  });
  assert.ok(out.stereo, 'должна быть стерео-дорожка');
  assert.equal(out.stereo.length, 2);
  assert.equal(out.stereo[0][0], mix.toInt16(0.75));
  assert.equal(out.stereo[1][0], mix.toInt16(0.25));
  assert.equal(out.stereo[0][1], mix.toInt16(0.5));
  assert.equal(out.stereo[1][1], mix.toInt16(0.5));
});

test('mix: громкости микрофона и компьютера применяются независимо', () => {
  const mic = f32([1]);
  const sys = f32([1]);
  const out = mix.mixBlock({
    mode: 'mix',
    mic,
    sysL: sys,
    sysR: sys,
    frames: 1,
    micGain: 0,
    sysGain: 0.5
  });
  assert.equal(out.stereo[0][0], mix.toInt16(0.5));
  assert.equal(out.stereo[1][0], mix.toInt16(0.5));
});

test('mix: сигнал не выходит за пределы Int16', () => {
  const out = mix.mixBlock({
    mode: 'mix',
    mic: f32([1]),
    sysL: f32([1]),
    sysR: f32([1]),
    frames: 1,
    micGain: 2,
    sysGain: 2
  });
  assert.equal(out.stereo[0][0], 32767);
  assert.equal(out.stereo[1][0], 32767);
});

test('split: микрофон слева, компьютер справа', () => {
  const out = mix.mixBlock({
    mode: 'split',
    mic: f32([0.4, 0]),
    sysL: f32([0.2, 0.6]),
    sysR: f32([0.6, 0]),
    frames: 2
  });
  assert.equal(out.stereo[0][0], mix.toInt16(0.4));
  assert.equal(out.stereo[0][1], 0);
  assert.equal(out.stereo[1][0], mix.toInt16(0.4));
  assert.equal(out.stereo[1][1], mix.toInt16(0.3));
});

test('dual: две дорожки с правильными каналами', () => {
  const out = mix.mixBlock({
    mode: 'dual',
    mic: f32([0.5]),
    sysL: f32([0.1]),
    sysR: f32([-0.1]),
    frames: 1
  });
  assert.equal(out.mic.length, 1);
  assert.equal(out.mic[0][0], mix.toInt16(0.5));
  assert.equal(out.system.length, 2);
  assert.equal(out.system[0][0], mix.toInt16(0.1));
  assert.equal(out.system[1][0], mix.toInt16(-0.1));
});

test('отсутствующие каналы и короткие массивы считаются тишиной', () => {
  const out = mix.mixBlock({ mode: 'mix', frames: 3, mic: f32([0.5]) });
  assert.equal(out.stereo[0].length, 3);
  assert.equal(out.stereo[0][0], mix.toInt16(0.5));
  assert.equal(out.stereo[0][1], 0);
  assert.equal(out.stereo[0][2], 0);
  assert.equal(out.stereo[1][2], 0);
});

test('sysR не задан — используется левый канал', () => {
  const out = mix.mixBlock({ mode: 'mix', mic: f32([0]), sysL: f32([0.5]), frames: 1 });
  assert.equal(out.stereo[0][0], mix.toInt16(0.5));
  assert.equal(out.stereo[1][0], mix.toInt16(0.5));
});

test('громкость ограничивается сверху', () => {
  const out = mix.mixBlock({
    mode: 'mix',
    mic: f32([0.1]),
    sysL: f32([0]),
    sysR: f32([0]),
    frames: 1,
    micGain: 100
  });
  assert.equal(out.stereo[0][0], mix.toInt16(0.4));
});

test('неизвестный режим превращается в mix', () => {
  const out = mix.mixBlock({ mode: 'nope', mic: f32([0.5]), frames: 1 });
  assert.ok(out.stereo);
  assert.equal(out.stereo[0][0], mix.toInt16(0.5));
});

test('tracksForMode описывает дорожки и роли', () => {
  assert.deepEqual(mix.tracksForMode('dual').map((t) => [t.id, t.channels]), [
    ['mic', 1],
    ['system', 2]
  ]);
  assert.deepEqual(mix.tracksForMode('mix').map((t) => [t.id, t.channels]), [['stereo', 2]]);
  assert.deepEqual(mix.tracksForMode('split').map((t) => t.id), ['stereo']);
});
