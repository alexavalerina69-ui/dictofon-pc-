import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..', 'src', 'renderer');

// В браузере/воркере lamejs подключается тегом <script>/importScripts.
// В Node тесте загружаем его в глобальный контекст так же, как в воркере.
vm.runInThisContext(fs.readFileSync(path.join(renderer, 'vendor', 'lame.min.js'), 'utf8'), {
  filename: 'lame.min.js'
});
require('../src/renderer/mix.js');
const { EncoderPipeline, TrackEncoder } = require('../src/renderer/encoder.js');

const SAMPLE_RATE = 48000;
const BLOCK = 2048;

function sineBlock(freq, amplitude, offset, frames = BLOCK, sampleRate = SAMPLE_RATE) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = Math.sin((2 * Math.PI * freq * (offset + i)) / sampleRate) * amplitude;
  }
  return out;
}

function isMp3Start(bytes) {
  return bytes.length > 3 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function runPipeline({ mode, seconds, bitRate = 192, micAmp = 0.2, sysAmp = 0.3 }) {
  const pipeline = new EncoderPipeline({ sampleRate: SAMPLE_RATE, bitRate, mode });
  const chunks = new Map();
  const collect = (items) => {
    for (const item of items) {
      if (!chunks.has(item.trackId)) chunks.set(item.trackId, []);
      chunks.get(item.trackId).push(Buffer.from(item.data));
    }
  };
  const blocks = Math.round((seconds * SAMPLE_RATE) / BLOCK);
  const started = process.hrtime.bigint();
  for (let b = 0; b < blocks; b++) {
    const start = b * BLOCK;
    collect(pipeline.push({
      mic: sineBlock(220, micAmp, start),
      sysL: sineBlock(440, sysAmp, start),
      sysR: sineBlock(660, sysAmp, start),
      frames: BLOCK,
      micGain: 1,
      sysGain: 1
    }));
  }
  collect(pipeline.flush());
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  const buffers = new Map();
  for (const [trackId, parts] of chunks) buffers.set(trackId, Buffer.concat(parts));
  return { buffers, elapsed, stats: pipeline.stats(), blocks };
}

test('mix: создаёт валидный стерео-MP3 с ожидаемым размером', () => {
  const { buffers, stats } = runPipeline({ mode: 'mix', seconds: 2 });
  const mp3 = buffers.get('stereo');
  assert.ok(mp3, 'есть дорожка stereo');
  assert.ok(isMp3Start(mp3), 'файл начинается с MP3-заголовка');
  const expected = (192 * 1000 * 2) / 8;
  assert.ok(mp3.length > expected * 0.8, `размер ${mp3.length} близок к ${expected}`);
  assert.ok(mp3.length < expected * 1.2, `размер ${mp3.length} близок к ${expected}`);
  assert.equal(stats[0].trackId, 'stereo');
  assert.ok(Math.abs(stats[0].seconds - 2) < 0.05);
});

test('dual: две дорожки, микрофон моно 128 кбит/с', () => {
  const { buffers, stats } = runPipeline({ mode: 'dual', seconds: 2 });
  assert.deepEqual([...buffers.keys()].sort(), ['mic', 'system']);
  assert.ok(isMp3Start(buffers.get('mic')));
  assert.ok(isMp3Start(buffers.get('system')));
  const micExpected = (128 * 1000 * 2) / 8;
  const sysExpected = (192 * 1000 * 2) / 8;
  assert.ok(Math.abs(buffers.get('mic').length - micExpected) < micExpected * 0.2);
  assert.ok(Math.abs(buffers.get('system').length - sysExpected) < sysExpected * 0.2);
  assert.equal(stats.length, 2);
});

test('split: один стереофайл', () => {
  const { buffers } = runPipeline({ mode: 'split', seconds: 1 });
  assert.deepEqual([...buffers.keys()], ['stereo']);
  assert.ok(isMp3Start(buffers.get('stereo')));
});

test('кодирование идёт заметно быстрее реального времени', () => {
  const { elapsed, blocks } = runPipeline({ mode: 'mix', seconds: 10 });
  const audioSeconds = (blocks * BLOCK) / SAMPLE_RATE;
  assert.ok(elapsed < audioSeconds * 1000 * 0.5, `10 с аудио закодированы за ${elapsed.toFixed(0)} мс`);
});

test('flush без данных возвращает только служебный кадр', () => {
  const pipeline = new EncoderPipeline({ sampleRate: SAMPLE_RATE, bitRate: 192, mode: 'mix' });
  const final = pipeline.flush();
  const total = final.reduce((sum, item) => sum + item.data.length, 0);
  assert.ok(total < 1024, 'без аудио файл почти пустой');
  assert.ok(isMp3Start(Buffer.from(final[0].data)));
});

test('неподдерживаемая частота дискретизации заменяется на 48 кГц', () => {
  const exotic = new TrackEncoder({ id: 'stereo', channels: 2, sampleRate: 96000, bitRate: 192 });
  assert.equal(exotic.sampleRate, 48000);
  const normal = new TrackEncoder({ id: 'stereo', channels: 2, sampleRate: 44100, bitRate: 128 });
  assert.equal(normal.sampleRate, 44100);
  const block = exotic.push([new Int16Array(2048), new Int16Array(2048)]);
  assert.ok(block && block.length > 0, 'энкодер всё равно пишет кадры');
});
