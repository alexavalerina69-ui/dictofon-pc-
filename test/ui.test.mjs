import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (err) {
  JSDOM = null;
}

const fakeContext = {
  clearRect() {},
  setTransform() {},
  beginPath() {},
  roundRect() {},
  moveTo() {},
  lineTo() {},
  quadraticCurveTo() {},
  arc() {},
  fill() {},
  stroke() {},
  save() {},
  restore() {},
  translate() {},
  scale() {},
  createLinearGradient() {
    return { addColorStop() {} };
  }
};

class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(message) {
    if (!message) return;
    if (message.type === 'init') {
      setTimeout(() => this.emit({ type: 'ready', tracks: ['stereo'] }), 0);
    } else if (message.type === 'block') {
      setTimeout(() => this.emit({ type: 'chunk', trackId: 'stereo', data: new Uint8Array(64) }), 0);
    } else if (message.type === 'flush') {
      setTimeout(() => this.emit({ type: 'done', trackId: 'stereo' }), 0);
    }
  }

  emit(data) {
    if (this.onmessage) this.onmessage({ data });
  }

  terminate() {}
}

function boot() {
  return new Promise((resolve) => {
    const dom = new JSDOM(html, {
      url: pathToFileURL(path.join(rendererDir, 'index.html')).href,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.ResizeObserver = class {
          observe() {}
          unobserve() {}
          disconnect() {}
        };
        window.HTMLCanvasElement.prototype.getContext = () => fakeContext;
        window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
          width: 640, height: 104, top: 0, left: 0, right: 640, bottom: 104, x: 0, y: 0
        });
        window.matchMedia = () => ({
          matches: false,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {}
        });
        window.Worker = FakeWorker;
        window.devicePixelRatio = 1;
        window.prompt = () => null;
        window.confirm = () => true;
        Object.defineProperty(window.navigator, 'mediaDevices', {
          configurable: true,
          value: {
            async enumerateDevices() {
              return [];
            },
            async getUserMedia() {
              const error = new Error('no microphone');
              error.name = 'NotFoundError';
              throw error;
            }
          }
        });
        if (window.crypto && !window.crypto.randomUUID) {
          window.crypto.randomUUID = () => 'test-' + Math.random().toString(36).slice(2);
        }
      }
    });

    const finish = () => resolve(dom);
    dom.window.addEventListener('load', () => setTimeout(finish, 60), { once: true });
    setTimeout(finish, 4000);
  });
}

async function waitFor(predicate, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

const skip = JSDOM ? false : 'jsdom не установлен (npm install)';

test('окно запускается, интерфейс на месте и пустой список записей', { skip }, async () => {
  const dom = await boot();
  const { window } = dom;
  const { document } = window;
  try {
    assert.ok(window.DictoApp, 'логика приложения загружена');
    assert.ok(window.DictoUI && window.DictoRecorder && window.DictoWaveform);
    assert.equal(window.DictoApp.state.phase, 'idle');
    assert.equal(document.getElementById('timer').textContent, '00:00');
    assert.ok(document.getElementById('recList').querySelector('.empty'), 'есть пустое состояние');
    assert.equal(document.getElementById('statusText').textContent, 'Готов к записи');
    assert.ok(document.body.classList.contains('no-electron'), 'в браузере скрыты кнопки окна');
    assert.equal(document.getElementById('demoPill').hidden, false);
    assert.match(document.getElementById('modeBadge').textContent, /Микс · MP3 192/);
    assert.ok(document.getElementById('btnSave').disabled, 'сохранять пока нечего');

    await waitFor(() => window.DictoApp.state.settings.saveDir !== '');
    assert.match(window.DictoApp.state.settings.saveDir, /Диктофон/);
  } finally {
    window.close();
  }
});

test('запись, пауза, продолжение и сохранение добавляют запись в список', { skip }, async () => {
  const dom = await boot();
  const { window } = dom;
  const { document } = window;
  try {
    await waitFor(() => window.DictoApp.state.settings.saveDir !== '');

    document.getElementById('btnRecord').click();
    assert.ok(await waitFor(() => window.DictoApp.state.phase === 'recording'), 'запись началась');
    assert.equal(document.getElementById('statusText').textContent, 'Идёт запись');

    await new Promise((resolve) => setTimeout(resolve, 1250));
    const firstTimer = document.getElementById('timer').textContent;
    assert.notEqual(firstTimer, '00:00', 'таймер идёт');
    assert.ok(window.DictoApp.state.engine.duration > 0.9, 'считается длительность');
    assert.ok(!document.getElementById('btnSave').disabled, 'кнопка сохранения активна');
    assert.ok(document.getElementById('btnDiscard').classList.contains('is-visible'));

    document.getElementById('btnRecord').click();
    assert.equal(window.DictoApp.state.phase, 'paused');
    assert.equal(document.getElementById('statusText').textContent, 'Пауза');
    const pausedTimer = document.getElementById('timer').textContent;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(document.getElementById('timer').textContent, pausedTimer, 'на паузе таймер стоит');

    document.getElementById('btnRecord').click();
    assert.equal(window.DictoApp.state.phase, 'recording');
    await new Promise((resolve) => setTimeout(resolve, 260));

    document.getElementById('btnSave').click();
    assert.ok(await waitFor(() => window.DictoApp.state.phase === 'idle', 6000), 'запись завершилась');
    assert.ok(await waitFor(() => window.DictoApp.state.recordings.length === 1), 'запись сохранилась');

    const entry = window.DictoApp.state.recordings[0];
    assert.ok(entry.duration > 0.3, 'длительность больше 0.3 с');
    assert.match(entry.name, /^Запись \d{4}-\d{2}-\d{2}/);
    assert.equal(document.getElementById('timer').textContent, '00:00');
    assert.equal(document.querySelectorAll('#recList .rec-item').length, 1);
    assert.match(document.querySelector('#recList .rec-name').textContent, /сегодня|вчера|\d/);

    // Удаление записи
    document.querySelector('#recList .rec-action[data-act="delete"]').click();
    assert.ok(await waitFor(() => window.DictoApp.state.recordings.length === 0), 'запись удалена');
    assert.ok(document.getElementById('recList').querySelector('.empty'));
  } finally {
    window.close();
  }
});

test('настройки: шторка, режим записи, громкость и горячие клавиши', { skip }, async () => {
  const dom = await boot();
  const { window } = dom;
  const { document } = window;
  try {
    await waitFor(() => window.DictoApp.state.settings.saveDir !== '');

    document.getElementById('btnSettings').click();
    const sheet = document.getElementById('settings');
    assert.ok(sheet.classList.contains('open'), 'шторка открыта');
    assert.equal(sheet.getAttribute('aria-hidden'), 'false');
    assert.ok(document.getElementById('backdrop').classList.contains('open'));

    document.querySelector('#modeGroup button[data-mode="dual"]').click();
    assert.equal(window.DictoApp.state.settings.mode, 'dual');
    assert.equal(sheet.querySelector('button[data-mode="dual"]').getAttribute('aria-checked'), 'true');
    assert.match(document.getElementById('modeBadge').textContent, /2 файла/);
    assert.match(document.getElementById('modeHint').textContent, /Два отдельных файла/);

    const range = document.getElementById('rngMic');
    range.value = '150';
    range.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(window.DictoApp.state.settings.micGain, 1.5);
    assert.equal(document.getElementById('micGainVal').textContent, '150%');
    assert.equal(range.style.getPropertyValue('--fill'), '75.0%');

    const systemSwitch = document.getElementById('swSystem');
    systemSwitch.checked = false;
    systemSwitch.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(window.DictoApp.state.settings.captureSystem, false);

    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!sheet.classList.contains('open'), 'Escape закрывает настройки');

    window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    assert.ok(await waitFor(() => window.DictoApp.state.phase === 'recording'), 'пробел начал запись');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    assert.equal(window.DictoApp.state.phase, 'paused');

    // Удаление несохранённой записи двумя нажатиями
    const discard = document.getElementById('btnDiscard');
    discard.click();
    assert.ok(discard.classList.contains('is-armed'), 'первое нажатие включает подтверждение');
    discard.click();
    assert.ok(await waitFor(() => window.DictoApp.state.phase === 'idle'), 'запись удалена');
    assert.ok(!document.getElementById('btnDiscard').classList.contains('is-visible'));
  } finally {
    window.close();
  }
});
