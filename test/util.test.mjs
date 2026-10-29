import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('../src/renderer/util.js');

test('formatTimer: минуты, часы и округление', () => {
  assert.equal(U.formatTimer(0), '00:00');
  assert.equal(U.formatTimer(5), '00:05');
  assert.equal(U.formatTimer(65.9), '01:05');
  assert.equal(U.formatTimer(3725), '1:02:05');
  assert.equal(U.formatTimer(-5), '00:00');
  assert.equal(U.formatTimer(undefined), '00:00');
});

test('formatBytes: русские единицы и запятая', () => {
  assert.equal(U.formatBytes(0), '0 Б');
  assert.equal(U.formatBytes(900), '900 Б');
  assert.equal(U.formatBytes(2048), '2,0 КБ');
  assert.equal(U.formatBytes(1024 * 1024 * 3.5), '3,5 МБ');
  assert.match(U.formatBytes(1024 ** 3 * 2.25), /^2,3 ГБ$/);
});

test('formatWhen: сегодня, вчера и дата', () => {
  const now = new Date(2026, 9, 29, 20, 15);
  const today = new Date(2026, 9, 29, 19, 42).toISOString();
  const yesterday = new Date(2026, 9, 28, 9, 5).toISOString();
  const old = new Date(2026, 8, 12, 18, 12).toISOString();
  assert.equal(U.formatWhen(today, now), 'сегодня, 19:42');
  assert.equal(U.formatWhen(yesterday, now), 'вчера, 09:05');
  assert.equal(U.formatWhen(old, now), '12 сен., 18:12');
  assert.equal(U.formatWhen('не дата', now), '');
  const lastYear = new Date(2025, 4, 3, 7, 8).toISOString();
  assert.match(U.formatWhen(lastYear, now), /^3 мая\. 2025, 07:08$/);
});

test('escapeHtml и truncateMiddle', () => {
  assert.equal(U.escapeHtml('<b>"x"</b>&'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;&amp;');
  assert.equal(U.escapeHtml(null), '');
  assert.equal(U.truncateMiddle('короткая строка', 40), 'короткая строка');
  assert.equal(U.truncateMiddle('0123456789abcdef', 9), '0123…cdef');
});

test('clamp и uid', () => {
  assert.equal(U.clamp(5, 0, 1), 1);
  assert.equal(U.clamp(-5, 0, 1), 0);
  assert.equal(U.clamp(0.5, 0, 1), 0.5);
  const first = U.uid();
  const second = U.uid();
  assert.equal(typeof first, 'string');
  assert.notEqual(first, second);
});

test('debounce: срабатывает один раз с последними аргументами', async () => {
  const calls = [];
  const debounced = U.debounce((value) => calls.push(value), 20);
  debounced(1);
  debounced(2);
  debounced(3);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls, [3]);
});
