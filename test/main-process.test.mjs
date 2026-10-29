/*
 * Интеграционный тест главного процесса без запуска Electron:
 * модуль `electron` подменяется заглушкой, а IPC-обработчики вызываются напрямую.
 * Проверяем запись чанков на диск, сохранение, список, чтение и удаление.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dictofon-test-'));
const userData = path.join(sandbox, 'userData');
const documents = path.join(sandbox, 'Documents');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(documents, { recursive: true });

/* ------------------------- заглушка electron ------------------------- */

const handlers = new Map();
const listeners = new Map();
const windows = [];
const permissionHandlers = {};

class FakeWebContents {
  constructor() {
    this.sent = [];
    this.destroyed = false;
    this.events = new Map();
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }

  on(event, callback) {
    this.events.set(event, callback);
  }

  isDestroyed() {
    return this.destroyed;
  }

  isDestroyedSafe() {
    return false;
  }

  isLoading() {
    return false;
  }

  getURL() {
    return 'app://dictofon/index.html';
  }

  setWindowOpenHandler() {}
}

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.events = new Map();
    this.maximized = false;
    this.visible = false;
    this.closed = false;
    this.destroyed = false;
    windows.push(this);
  }

  setMenuBarVisibility() {}

  loadURL(url) {
    this.loadedURL = url;
  }

  once(event, callback) {
    this.events.set('once:' + event, callback);
  }

  on(event, callback) {
    this.events.set(event, callback);
  }

  show() {
    this.visible = true;
  }

  close() {
    const closeHandler = this.events.get('close');
    if (closeHandler) {
      let prevented = false;
      closeHandler({ preventDefault: () => { prevented = true; } });
      if (prevented) return;
    }
    this.closed = true;
    const closedHandler = this.events.get('closed');
    if (closedHandler) closedHandler();
  }

  isDestroyed() {
    return this.destroyed || this.closed;
  }

  isMaximized() {
    return this.maximized;
  }

  maximize() {
    this.maximized = true;
    const handler = this.events.get('maximize');
    if (handler) handler();
  }

  unmaximize() {
    this.maximized = false;
    const handler = this.events.get('unmaximize');
    if (handler) handler();
  }

  minimize() {
    this.minimized = true;
  }

  restore() {}

  focus() {}
}

const electronStub = {
  app: {
    commandLine: { appendSwitch() {} },
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getVersion: () => '1.0.0',
    getPath(name) {
      if (name === 'userData') return userData;
      if (name === 'documents') return documents;
      return sandbox;
    },
    setAppUserModelId() {},
    on(event, callback) {
      listeners.set(event, callback);
    },
    quit() {}
  },
  BrowserWindow: Object.assign(FakeBrowserWindow, {
    getAllWindows: () => windows.filter((win) => !win.closed)
  }),
  Menu: { setApplicationMenu() {} },
  ipcMain: {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on(channel, handler) {
      handlers.set(channel, handler);
    }
  },
  session: {
    defaultSession: {
      setDisplayMediaRequestHandler(handler, options) {
        permissionHandlers.displayMedia = { handler, options };
      },
      setPermissionRequestHandler(handler) {
        permissionHandlers.request = handler;
      },
      setPermissionCheckHandler(handler) {
        permissionHandlers.check = handler;
      }
    }
  },
  desktopCapturer: {
    async getSources() {
      return [{ id: 'screen:0:0', name: 'Весь экран' }];
    }
  },
  dialog: {
    async showOpenDialog(window, options) {
      return { canceled: false, filePaths: [path.join(sandbox, 'Выбранная папка')] };
    },
    async showMessageBox(window, options) {
      return { response: options.buttons.length - 2 };
    }
  },
  shell: {
    showItemInFolder(file) {
      shellCalls.revealed.push(file);
    },
    async openPath(folder) {
      shellCalls.opened.push(folder);
      return '';
    },
    async trashItem(file) {
      shellCalls.trashed.push(file);
      await fs.promises.rm(file, { force: true });
    }
  },
  protocol: {
    registerSchemesAsPrivileged(schemes) {
      electronStub.privilegedSchemes = schemes;
    },
    handle(scheme, handler) {
      electronStub.protocolHandler = { scheme, handler };
    }
  },
  net: {
    async fetch() {
      throw new Error('net.fetch не должен использоваться');
    }
  },
  webContents: {
    fromId() {
      return null;
    }
  }
};

const shellCalls = { revealed: [], opened: [], trashed: [] };

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

require('../src/main.js');
Module._load = originalLoad;

function invoke(channel, ...args) {
  const handler = handlers.get(channel);
  assert.ok(handler, `обработчик ${channel} зарегистрирован`);
  return handler({ sender: windows[0] ? windows[0].webContents : null }, ...args);
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

await waitFor(() => handlers.has('rec:begin') && windows.length > 0);

/* ------------------------------- тесты ------------------------------- */

test('главный процесс поднимает окно и все IPC-обработчики', () => {
  assert.ok(handlers.size >= 18, `зарегистрировано ${handlers.size} обработчиков`);
  const window = windows[0];
  assert.equal(window.options.frame, false);
  assert.equal(window.options.transparent, true);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.loadedURL, 'app://dictofon/index.html');
  assert.deepEqual(electronStub.privilegedSchemes.map((s) => s.scheme), ['app']);
});

test('системный звук настраивается через loopback', () => {
  assert.ok(permissionHandlers.displayMedia, 'обработчик display media установлен');
  assert.equal(permissionHandlers.displayMedia.options.useSystemPicker, false);
  // Проверяем разрешения
  const granted = [];
  permissionHandlers.request(
    { getURL: () => 'app://dictofon/index.html' },
    'media',
    (ok) => granted.push(ok),
    { mediaTypes: ['audio'] }
  );
  permissionHandlers.request(
    { getURL: () => 'app://dictofon/index.html' },
    'media',
    (ok) => granted.push(ok),
    { mediaTypes: ['video'] }
  );
  permissionHandlers.request(
    { getURL: () => 'https://evil.example/' },
    'media',
    (ok) => granted.push(ok),
    { mediaTypes: ['audio'] }
  );
  permissionHandlers.request(
    { getURL: () => 'app://dictofon/index.html' },
    'display-capture',
    (ok) => granted.push(ok),
    { mediaTypes: ['video', 'audio'] }
  );
  assert.deepEqual(granted, [true, false, false, true]);
  assert.equal(permissionHandlers.check(null, 'media', 'app://dictofon', { mediaType: 'audio' }), true);
  assert.equal(permissionHandlers.check(null, 'media', 'app://dictofon', { mediaType: 'video' }), false);
});

test('протокол app:// отдаёт файлы с правильным Content-Type и не выпускает наружу', async () => {
  const { handler } = electronStub.protocolHandler;
  const css = await handler({ url: 'app://dictofon/styles.css' });
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.ok((await css.text()).includes('.app'));

  const js = await handler({ url: 'app://dictofon/app.js' });
  assert.match(js.headers.get('content-type'), /text\/javascript/);

  const html = await handler({ url: 'app://dictofon/' });
  assert.match(html.headers.get('content-type'), /text\/html/);

  const escape = await handler({ url: 'app://dictofon/..%2F..%2Fsrc%2Fmain.js' });
  assert.ok([403, 404].includes(escape.status), 'выход за пределы папки заблокирован');

  const wrongHost = await handler({ url: 'app://other/index.html' });
  assert.equal(wrongHost.status, 404);
});

test('настройки: значения по умолчанию, ограничения и выбор папки', async () => {
  const initial = await invoke('settings:get');
  assert.equal(initial.mode, 'mix');
  assert.equal(initial.bitRate, 192);
  assert.equal(initial.micGain, 1);
  assert.match(initial.saveDir, /Диктофон$/);

  const saved = await invoke('settings:set', {
    micGain: 9,
    sysGain: -2,
    mode: 'dual',
    bitRate: 999,
    captureSystem: false
  });
  assert.equal(saved.micGain, 2, 'громкость ограничена сверху');
  assert.equal(saved.sysGain, 0, 'громкость ограничена снизу');
  assert.equal(saved.mode, 'dual');
  assert.equal(saved.bitRate, 192, 'недопустимый битрейт отброшен');
  assert.equal(saved.captureSystem, false);

  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  assert.equal(onDisk.mode, 'dual');

  const folder = await invoke('settings:choose-folder');
  assert.match(folder, /Выбранная папка$/);
  assert.ok(fs.existsSync(folder), 'папка создана');
});

test('полный цикл: чанки → конец → сохранение файлов на диск', async () => {
  const settings = await invoke('settings:get');
  const { sessionId } = await invoke('rec:begin', {
    tracks: [{ id: 'stereo', ext: 'mp3' }]
  });
  assert.match(sessionId, /^[0-9a-f-]{36}$/);

  const chunkA = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
  const chunkB = Buffer.from([5, 6, 7, 8, 9, 10]);
  const resultA = await invoke('rec:chunk', { sessionId, trackId: 'stereo', data: chunkA });
  const resultB = await invoke('rec:chunk', { sessionId, trackId: 'stereo', data: chunkB });
  assert.equal(resultA.ok, true);
  assert.equal(resultB.bytes, chunkA.length + chunkB.length);

  // Uint8Array в IPC тоже должен приниматься
  const typed = await invoke('rec:chunk', {
    sessionId,
    trackId: 'stereo',
    data: new Uint8Array([11, 12])
  });
  assert.equal(typed.ok, true);

  const ended = await invoke('rec:end', { sessionId, duration: 1 });
  assert.equal(ended.tracks.length, 1);
  assert.equal(ended.tracks[0].size, chunkA.length + chunkB.length + 2);

  const startedAt = '2026-10-29T19:42:05.000Z';
  const entry = await invoke('rec:save', {
    sessionId,
    duration: 12.5,
    startedAt,
    mode: 'mix'
  });
  assert.match(entry.name, /^Запись \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/);
  assert.equal(entry.duration, 12.5);
  assert.equal(entry.mode, 'mix');
  assert.equal(entry.files.length, 1);
  assert.ok(entry.files[0].path.startsWith(settings.saveDir));
  assert.ok(fs.existsSync(entry.files[0].path), 'файл записи существует');

  const written = fs.readFileSync(entry.files[0].path);
  assert.deepEqual([...written], [...chunkA, ...chunkB, 11, 12]);
  assert.equal(entry.size, written.length);

  // Список, чтение и повторное сохранение с тем же временем
  const list = await invoke('recordings:list');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, entry.id);

  const read = await invoke('recordings:read', entry.id);
  assert.deepEqual([...read.data], [...written]);
  assert.equal(read.mime, 'audio/mpeg');

  const { sessionId: second } = await invoke('rec:begin', { tracks: [{ id: 'stereo' }] });
  await invoke('rec:chunk', { sessionId: second, trackId: 'stereo', data: chunkA });
  await invoke('rec:end', { sessionId: second, duration: 1 });
  const duplicate = await invoke('rec:save', { sessionId: second, duration: 1, startedAt, mode: 'mix' });
  assert.notEqual(duplicate.files[0].path, entry.files[0].path, 'имена файлов не пересекаются');
  assert.match(duplicate.name, /\(2\)$/);

  await invoke('recordings:remove', duplicate.id);
  assert.equal((await invoke('recordings:list')).length, 1);
  assert.ok(shellCalls.trashed.length >= 1);
});

test('две дорожки сохраняются как два отдельных файла', async () => {
  const { sessionId } = await invoke('rec:begin', {
    tracks: [{ id: 'mic' }, { id: 'system' }]
  });
  await invoke('rec:chunk', { sessionId, trackId: 'mic', data: Buffer.from([1, 2, 3]) });
  await invoke('rec:chunk', { sessionId, trackId: 'system', data: Buffer.from([4, 5, 6, 7]) });
  await invoke('rec:end', { sessionId, duration: 2 });
  const entry = await invoke('rec:save', { sessionId, duration: 2, mode: 'dual' });
  assert.equal(entry.files.length, 2);
  const names = entry.files.map((file) => path.basename(file.path)).sort();
  assert.match(names[0], /\(компьютер\)\.mp3$/);
  assert.match(names[1], /\(микрофон\)\.mp3$/);
  assert.equal(entry.size, 7);
});

test('пустая сессия не создаёт запись, а discard убирает временные файлы', async () => {
  const { sessionId } = await invoke('rec:begin', { tracks: [{ id: 'stereo' }] });
  await invoke('rec:end', { sessionId, duration: 0.1 });
  await assert.rejects(() => invoke('rec:save', { sessionId, duration: 0.1 }), /пустая/i);

  const discard = await invoke('rec:begin', { tracks: [{ id: 'stereo' }] });
  await invoke('rec:chunk', { sessionId: discard.sessionId, trackId: 'stereo', data: Buffer.from([1]) });
  assert.equal(await invoke('rec:discard', { sessionId: discard.sessionId }), true);
  const tempDir = path.join(userData, 'temp', discard.sessionId);
  assert.ok(!fs.existsSync(tempDir), 'временная папка удалена');
});

test('диалоги: несохранённая запись и подтверждение удаления', async () => {
  const unsaved = await invoke('dialog:unsaved');
  assert.ok(['save', 'discard', 'cancel'].includes(unsaved));
  const confirm = await invoke('dialog:confirm-delete', { name: 'Запись' });
  assert.equal(typeof confirm, 'boolean');
});

test('закрытие окна перехватывается, пока запись не подтверждена', () => {
  const window = windows[0];
  window.webContents.sent.length = 0;
  window.close();
  assert.equal(window.closed, false, 'окно не закрылось сразу');
  assert.deepEqual(window.webContents.sent.map((item) => item.channel), ['app:close-requested']);
  const closeRequested = listeners.get('window-all-closed');
  assert.equal(typeof closeRequested, 'function');
});

test.after(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch (err) {
    // временная папка могла остаться открытой в Windows
  }
});
