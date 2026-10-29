import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');

const main = fs.readFileSync(path.join(src, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(src, 'preload.js'), 'utf8');
const app = fs.readFileSync(path.join(src, 'renderer', 'app.js'), 'utf8');
const shim = fs.readFileSync(path.join(src, 'renderer', 'preview-shim.js'), 'utf8');

function unique(matches) {
  return [...new Set(matches)];
}

const handled = unique([
  ...[...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]),
  ...[...main.matchAll(/ipcMain\.on\('([^']+)'/g)].map((m) => m[1])
]);

const bridged = unique([
  ...[...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]),
  ...[...preload.matchAll(/ipcRenderer\.send\('([^']+)'/g)].map((m) => m[1])
]);

test('все каналы из preload обрабатываются в главном процессе', () => {
  const missing = bridged.filter((channel) => !handled.includes(channel));
  assert.deepEqual(missing, []);
  assert.ok(bridged.length >= 15, 'мост покрывает все группы API');
});

test('в главном процессе нет «потерянных» обработчиков без моста', () => {
  const unused = handled.filter((channel) => !bridged.includes(channel) && !channel.startsWith('app:close-requested'));
  assert.deepEqual(unused, []);
});

const bridgeCalls = unique([...app.matchAll(/bridge\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)].map((m) => `${m[1]}.${m[2]}`));
const bridgeGroups = unique([...app.matchAll(/bridge\.([a-zA-Z]+)\./g)].map((m) => m[1]));

test('окно использует только методы из preload и демо-моста', () => {
  assert.ok(bridgeCalls.length >= 8, 'найдены вызовы моста');
  for (const group of bridgeGroups) {
    assert.match(preload, new RegExp(`\\b${group}:\\s*\\{`), `группа ${group} есть в preload`);
    assert.match(shim, new RegExp(`\\b${group}:\\s*\\{`), `группа ${group} есть в демо-мосте`);
  }
  for (const call of bridgeCalls) {
    const [group, method] = call.split('.');
    const inPreload = new RegExp(`\\b${method}:\\s*\\(`).test(preload);
    const inShim = new RegExp(`\\b${method}\\(`).test(shim);
    assert.ok(inPreload, `preload.${group}.${method} существует`);
    assert.ok(inShim, `демо-мост.${group}.${method} существует`);
  }
});

test('окно защищено: изоляция контекста, sandbox и CSP', () => {
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'/);
  assert.match(main, /will-navigate/);
  const html = fs.readFileSync(path.join(src, 'renderer', 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'/);
  assert.ok(!/<script>[^<]/.test(html), 'нет встроенных скриптов');
});

test('системный звук запрашивается через loopback', () => {
  assert.match(main, /setDisplayMediaRequestHandler/);
  assert.match(main, /audio:\s*'loopback'/);
  const engine = fs.readFileSync(path.join(src, 'renderer', 'engine.js'), 'utf8');
  assert.match(engine, /getDisplayMedia/);
  assert.match(engine, /capture-worklet\.js/);
  assert.match(engine, /getUserMedia/);
});
