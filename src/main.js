/*
 * Dictofon — главный процесс Electron.
 *
 * Отвечает за окно, захват системного звука (WASAPI loopback), настройки,
 * потоковую запись MP3-чанков на диск, сохранение и список записей.
 */
'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  session,
  desktopCapturer,
  dialog,
  shell,
  protocol
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const APP_ORIGIN = 'app://dictofon';
const MAX_PREVIEW_BYTES = 300 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
]);

if (process.platform === 'win32') {
  app.setAppUserModelId('com.dictofon.app');
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let allowClose = false;
let closeWatchdog = null;
let settings = null;
let recordings = [];
const sessions = new Map();

/* ------------------------------------------------------------------ */
/* Настройки и список записей                                          */
/* ------------------------------------------------------------------ */

function defaultSettings() {
  return {
    micDeviceId: 'default',
    micGain: 1,
    sysGain: 1,
    mode: 'mix',
    bitRate: 192,
    captureSystem: true,
    saveDir: path.join(app.getPath('documents'), 'Диктофон')
  };
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function recordingsFile() {
  return path.join(app.getPath('userData'), 'recordings.json');
}

function tempRoot() {
  return path.join(app.getPath('userData'), 'temp');
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function sanitizeSettings(raw) {
  const base = defaultSettings();
  const merged = Object.assign({}, base, raw || {});
  const result = {
    micDeviceId: typeof merged.micDeviceId === 'string' && merged.micDeviceId ? merged.micDeviceId : 'default',
    micGain: clampNumber(merged.micGain, 0, 2, 1),
    sysGain: clampNumber(merged.sysGain, 0, 2, 1),
    mode: ['mix', 'split', 'dual'].includes(merged.mode) ? merged.mode : 'mix',
    bitRate: [128, 192, 320].includes(Number(merged.bitRate)) ? Number(merged.bitRate) : 192,
    captureSystem: merged.captureSystem !== false,
    saveDir: typeof merged.saveDir === 'string' && merged.saveDir ? merged.saveDir : base.saveDir
  };
  return result;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

function sanitizeRecordings(raw) {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw.filter((entry) => {
    return entry && typeof entry.id === 'string' && typeof entry.name === 'string' &&
      Array.isArray(entry.files) && entry.files.length > 0 &&
      entry.files.every((file) => file && typeof file.path === 'string');
  }).map((entry) => ({
    id: entry.id,
    name: entry.name,
    createdAt: entry.createdAt || new Date(now).toISOString(),
    duration: clampNumber(entry.duration, 0, 24 * 3600, 0),
    mode: ['mix', 'split', 'dual'].includes(entry.mode) ? entry.mode : 'mix',
    size: clampNumber(entry.size, 0, Number.MAX_SAFE_INTEGER, 0),
    files: entry.files.map((file) => ({ path: file.path, role: file.role || 'mixed' }))
  }));
}

async function loadStores() {
  const rawSettings = await readJson(settingsFile(), {});
  settings = sanitizeSettings(rawSettings);
  recordings = sanitizeRecordings(await readJson(recordingsFile(), []));
  try {
    await fsp.mkdir(settings.saveDir, { recursive: true });
  } catch (err) {
    // папку можно выбрать заново в настройках
  }
}

function pruneRecordings() {
  let changed = false;
  const kept = [];
  for (const entry of recordings) {
    const files = [];
    let size = 0;
    for (const file of entry.files) {
      try {
        const stat = fs.statSync(file.path);
        if (stat.isFile()) {
          files.push(file);
          size += stat.size;
        }
      } catch (err) {
        changed = true;
      }
    }
    if (files.length) {
      if (size !== entry.size) changed = true;
      kept.push(Object.assign({}, entry, { files, size }));
    } else {
      changed = true;
    }
  }
  recordings = kept;
  if (changed) writeJson(recordingsFile(), recordings).catch(() => {});
  return recordings;
}

async function cleanupTemp() {
  const root = tempRoot();
  let entries = [];
  try {
    entries = await fsp.readdir(root);
  } catch (err) {
    return;
  }
  for (const name of entries) {
    await fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}

function baseNameFor(iso) {
  const date = iso ? new Date(iso) : new Date();
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (value) => (value < 10 ? '0' + value : String(value));
  return `Запись ${valid.getFullYear()}-${pad(valid.getMonth() + 1)}-${pad(valid.getDate())} ` +
    `${pad(valid.getHours())}-${pad(valid.getMinutes())}-${pad(valid.getSeconds())}`;
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (err) {
    return false;
  }
}

async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(from, to);
      await fsp.unlink(from).catch(() => {});
      return;
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Захват системного звука и разрешения                                */
/* ------------------------------------------------------------------ */

function setupMediaSession() {
  const ses = session.defaultSession;

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      });
      if (!sources.length) {
        callback({});
        return;
      }
      // Окно не показывает видео: нужен только loopback-звук рабочего стола.
      callback({ video: sources[0], audio: 'loopback' });
    } catch (err) {
      callback({});
    }
  }, { useSystemPicker: false });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = webContents.getURL();
    if (!url.startsWith(APP_ORIGIN)) {
      callback(false);
      return;
    }
    if (permission === 'media') {
      const types = (details && details.mediaTypes) || [];
      callback(types.length === 0 || types.every((type) => type === 'audio'));
      return;
    }
    callback(['display-capture', 'audioCapture', 'clipboard-sanitized-write'].includes(permission));
  });

  ses.setPermissionCheckHandler((webContents, permission, origin, details) => {
    const originOk = !origin || origin.startsWith('app://') || origin.startsWith('file://');
    if (!originOk) return false;
    if (permission === 'media') {
      // details.mediaType: 'audio' | 'video' | 'unknown'. Камеру не разрешаем.
      return !details || details.mediaType !== 'video';
    }
    return ['display-capture', 'audioCapture', 'clipboard-sanitized-write'].includes(permission);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'dictofon') return new Response('Not found', { status: 404 });
      let relative = decodeURIComponent(url.pathname);
      if (!relative || relative === '/') relative = '/index.html';
      if (relative === '/favicon.ico') relative = '/assets/icon.png';
      const target = path.normalize(path.join(RENDERER_DIR, relative));
      const rootWithSep = RENDERER_DIR + path.sep;
      if (target !== RENDERER_DIR && !target.startsWith(rootWithSep)) {
        return new Response('Forbidden', { status: 403 });
      }
      const stat = await fsp.stat(target);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const type = MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
      // Отдаём файл сами, с явным Content-Type: так скрипты и стили
      // гарантированно не блокируются строгой проверкой MIME.
      const body = Readable.toWeb(fs.createReadStream(target));
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': type,
          'content-length': String(stat.size),
          'cache-control': 'no-store'
        }
      });
    } catch (err) {
      return new Response('Not found', { status: 404 });
    }
  });
}

/* ------------------------------------------------------------------ */
/* Окно                                                                */
/* ------------------------------------------------------------------ */

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 880,
    minHeight: 610,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    title: 'Диктофон',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.DICTOFON_DEVTOOLS === '1'
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('maximize', () => sendToRenderer('win:maximized', true));
  mainWindow.on('unmaximize', () => sendToRenderer('win:maximized', false));

  mainWindow.on('close', (event) => {
    if (allowClose) return;
    const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (!contents || contents.isDestroyed() || contents.isLoading()) {
      allowClose = true;
      return;
    }
    event.preventDefault();
    sendToRenderer('app:close-requested');
    // Если окно не ответит (зависло), закрываемся принудительно.
    clearTimeout(closeWatchdog);
    closeWatchdog = setTimeout(() => {
      allowClose = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    }, 20000);
    if (closeWatchdog && typeof closeWatchdog.unref === 'function') closeWatchdog.unref();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    saveDir: settings.saveDir
  }));

  ipcMain.handle('app:close-now', () => {
    clearTimeout(closeWatchdog);
    allowClose = true;
    if (mainWindow) mainWindow.close();
    return true;
  });

  ipcMain.on('win:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('win:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on('win:close', () => {
    clearTimeout(closeWatchdog);
    if (mainWindow) mainWindow.close();
  });

  ipcMain.handle('settings:get', () => Object.assign({}, settings));

  ipcMain.handle('settings:set', async (event, patch) => {
    settings = sanitizeSettings(Object.assign({}, settings, patch || {}));
    await writeJson(settingsFile(), settings);
    try {
      await fsp.mkdir(settings.saveDir, { recursive: true });
    } catch (err) {
      // игнорируем: пользователь увидит ошибку при сохранении
    }
    return Object.assign({}, settings);
  });

  ipcMain.handle('settings:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Папка для записей',
      buttonLabel: 'Выбрать',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.saveDir
    });
    if (result.canceled || !result.filePaths.length) return null;
    settings.saveDir = result.filePaths[0];
    await writeJson(settingsFile(), settings);
    try {
      await fsp.mkdir(settings.saveDir, { recursive: true });
    } catch (err) {
      // папка может быть недоступна — пользователь увидит ошибку при сохранении
    }
    return settings.saveDir;
  });

  ipcMain.handle('recordings:list', () => pruneRecordings().slice());

  ipcMain.handle('recordings:read', async (event, id) => {
    const entry = recordings.find((item) => item.id === id);
    if (!entry) throw new Error('Запись не найдена');
    const file = entry.files[0];
    const stat = await fsp.stat(file.path);
    if (stat.size > MAX_PREVIEW_BYTES) throw new Error('Файл слишком большой для прослушивания');
    const data = await fsp.readFile(file.path);
    return {
      data: new Uint8Array(data),
      mime: 'audio/mpeg',
      name: path.basename(file.path),
      size: stat.size
    };
  });

  ipcMain.handle('recordings:reveal', (event, id) => {
    const entry = recordings.find((item) => item.id === id);
    if (!entry) throw new Error('Запись не найдена');
    shell.showItemInFolder(entry.files[0].path);
    return true;
  });

  ipcMain.handle('recordings:open-folder', async () => {
    try {
      await fsp.mkdir(settings.saveDir, { recursive: true });
    } catch (err) {
      // папка могла быть удалена
    }
    const error = await shell.openPath(settings.saveDir);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('recordings:remove', async (event, id) => {
    const index = recordings.findIndex((item) => item.id === id);
    if (index === -1) return false;
    const entry = recordings[index];
    for (const file of entry.files) {
      try {
        await shell.trashItem(file.path);
      } catch (err) {
        await fsp.unlink(file.path).catch(() => {});
      }
    }
    recordings.splice(index, 1);
    await writeJson(recordingsFile(), recordings);
    return true;
  });

  ipcMain.handle('dialog:unsaved', async () => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Диктофон',
      message: 'Запись ещё не сохранена',
      detail: 'Сохранить запись перед закрытием приложения?',
      buttons: ['Сохранить', 'Не сохранять', 'Отмена'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    return ['save', 'discard', 'cancel'][result.response] || 'cancel';
  });

  ipcMain.handle('dialog:confirm-delete', async (event, entry) => {
    const name = entry && entry.name ? entry.name : 'эту запись';
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Удалить запись?',
      message: `Удалить «${name}»?`,
      detail: 'Файлы будут перемещены в корзину.',
      buttons: ['Удалить', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    return result.response === 0;
  });

  /* --- запись: сессии и чанки ------------------------------------- */

  ipcMain.handle('rec:begin', async (event, payload) => {
    const requested = payload && Array.isArray(payload.tracks) ? payload.tracks : [];
    if (!requested.length) throw new Error('Не выбраны дорожки записи');
    const id = crypto.randomUUID();
    const dir = path.join(tempRoot(), id);
    await fsp.mkdir(dir, { recursive: true });
    const tracks = new Map();
    for (const item of requested) {
      const trackId = String(item && item.id ? item.id : '').replace(/[^a-z0-9_-]/gi, '');
      if (!trackId || tracks.has(trackId)) continue;
      const file = path.join(dir, `${trackId}.mp3`);
      const stream = fs.createWriteStream(file);
      const track = { path: file, stream, bytes: 0, error: null };
      stream.on('error', (err) => {
        track.error = err;
      });
      tracks.set(trackId, track);
    }
    sessions.set(id, { dir, tracks, startedAt: Date.now() });
    return { sessionId: id, dir };
  });

  ipcMain.handle('rec:chunk', async (event, payload) => {
    const sess = payload && sessions.get(payload.sessionId);
    const track = sess && sess.tracks.get(payload.trackId);
    if (!track || track.error) return { ok: false };
    let buffer = null;
    if (Buffer.isBuffer(payload.data)) buffer = payload.data;
    else if (payload.data instanceof ArrayBuffer) buffer = Buffer.from(new Uint8Array(payload.data));
    else if (ArrayBuffer.isView(payload.data)) {
      buffer = Buffer.from(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength);
    }
    if (!buffer || !buffer.length) return { ok: true };
    track.bytes += buffer.length;
    const canContinue = track.stream.write(buffer);
    if (!canContinue) {
      await new Promise((resolve) => {
        const done = () => {
          track.stream.removeListener('drain', done);
          track.stream.removeListener('error', done);
          resolve();
        };
        track.stream.once('drain', done);
        track.stream.once('error', done);
      });
    }
    return { ok: !track.error, bytes: track.bytes };
  });

  ipcMain.handle('rec:end', async (event, payload) => {
    const id = payload && payload.sessionId;
    const sess = id ? sessions.get(id) : null;
    if (!sess) return { tracks: [] };
    const result = [];
    for (const [trackId, track] of sess.tracks) {
      await new Promise((resolve) => {
        if (track.stream.writableEnded || track.stream.destroyed) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 5000);
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        track.stream.once('error', finish);
        track.stream.end(finish);
      });
      let size = track.bytes;
      try {
        const stat = await fsp.stat(track.path);
        size = stat.size;
      } catch (err) {
        size = track.bytes;
      }
      result.push({
        id: trackId,
        role: trackId,
        path: track.path,
        size,
        bytes: track.bytes
      });
    }
    return { tracks: result, duration: (payload && payload.duration) || 0 };
  });

  ipcMain.handle('rec:save', async (event, payload) => {
    const id = payload && payload.sessionId;
    const sess = id ? sessions.get(id) : null;
    if (!sess) throw new Error('Сессия записи не найдена');

    const entries = [...sess.tracks.entries()].filter(([, track]) => (track.bytes || 0) > 0);
    if (!entries.length) {
      await cleanupSession(id);
      throw new Error('Запись пустая');
    }

    await fsp.mkdir(settings.saveDir, { recursive: true });
    const multi = entries.length > 1;
    const suffixFor = (trackId) => {
      if (!multi) return '';
      if (trackId === 'mic') return ' (микрофон)';
      if (trackId === 'system') return ' (компьютер)';
      return ' (' + trackId + ')';
    };

    const startedAt = payload.startedAt || new Date(sess.startedAt).toISOString();
    const base = baseNameFor(startedAt);
    let name = base;
    let targets = [];
    for (let attempt = 1; attempt <= 200; attempt++) {
      name = attempt === 1 ? base : `${base} (${attempt})`;
      targets = entries.map(([trackId]) => path.join(settings.saveDir, `${name}${suffixFor(trackId)}.mp3`));
      if (!targets.some(fileExists)) break;
      if (attempt === 200) throw new Error('Не удалось подобрать имя файла');
    }

    const files = [];
    let size = 0;
    for (let i = 0; i < entries.length; i++) {
      const [trackId, track] = entries[i];
      const target = targets[i];
      await moveFile(track.path, target);
      let fileSize = track.bytes;
      try {
        fileSize = (await fsp.stat(target)).size;
      } catch (err) {
        fileSize = track.bytes;
      }
      size += fileSize;
      files.push({ path: target, role: trackId });
    }

    const entry = {
      id: crypto.randomUUID(),
      name,
      createdAt: startedAt,
      duration: clampNumber(payload.duration, 0, 24 * 3600, 0),
      mode: ['mix', 'split', 'dual'].includes(payload.mode) ? payload.mode : 'mix',
      size,
      files
    };
    recordings.unshift(entry);
    recordings = recordings.slice(0, 400);
    await writeJson(recordingsFile(), recordings);
    await cleanupSession(id);
    return entry;
  });

  ipcMain.handle('rec:discard', async (event, payload) => {
    const id = payload && payload.sessionId;
    if (id) await cleanupSession(id);
    return true;
  });
}

async function cleanupSession(id) {
  const sess = sessions.get(id);
  if (!sess) return;
  sessions.delete(id);
  for (const track of sess.tracks.values()) {
    try {
      if (!track.stream.destroyed) track.stream.destroy();
    } catch (err) {
      // поток уже закрыт
    }
  }
  await fsp.rm(sess.dir, { recursive: true, force: true }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Жизненный цикл                                                      */
/* ------------------------------------------------------------------ */

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    setupMediaSession();
    await loadStores();
    registerIpc();
    createWindow();
    cleanupTemp().catch(() => {});
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    for (const id of [...sessions.keys()]) {
      cleanupSession(id).catch(() => {});
    }
  });

  app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(APP_ORIGIN)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
