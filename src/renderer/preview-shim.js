/*
 * Dictofon — браузерный предпросмотр интерфейса.
 *
 * В Electron этот файл ничего не делает: мост window.dictofon уже создан
 * preload-скриптом. В обычном браузере он поднимает «демо-мост», который
 * повторяет API главного процесса: запись, сохранение, список, настройки.
 * Аудио в демо синтезируется, но проходит через настоящий MP3-энкодер.
 */
(function (root) {
  'use strict';

  if (root.dictofon) return;

  const STORAGE_KEY = 'dictofon.demo.v1';
  const DEMO_DIR = 'C:\\Users\\Демо\\Документы\\Диктофон';
  const DEFAULT_SETTINGS = {
    micDeviceId: 'default',
    micGain: 1,
    sysGain: 1,
    mode: 'mix',
    bitRate: 192,
    captureSystem: true,
    saveDir: DEMO_DIR
  };

  const store = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    recordings: []
  };
  const blobs = new Map();
  const sessions = new Map();
  let lastSessionId = null;

  function notify(message, type) {
    if (root.DictoUI && typeof root.DictoUI.toast === 'function') {
      root.DictoUI.toast(message, type || 'info');
    } else {
      console.info('[демо]', message);
    }
  }

  function load() {
    try {
      const raw = root.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      store.settings = Object.assign({}, DEFAULT_SETTINGS, saved.settings || {});
      store.recordings = Array.isArray(saved.recordings) ? saved.recordings : [];
    } catch (err) {
      // повреждённые данные демо не критичны
    }
  }

  function persist() {
    try {
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        settings: store.settings,
        recordings: store.recordings.slice(0, 30)
      }));
    } catch (err) {
      // приватный режим браузера
    }
  }

  function stampName(iso) {
    const date = iso ? new Date(iso) : new Date();
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return `Запись ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  }

  function uid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return 'demo-' + Math.random().toString(36).slice(2);
  }

  /* --------------------------------------------------------------- */
  /* Синтез WAV для старых демо-записей                              */
  /* --------------------------------------------------------------- */

  function writeString(view, offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function toWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);
    new Int16Array(buffer, 44).set(samples);
    return new Uint8Array(buffer);
  }

  function synthMelody(duration) {
    const sampleRate = 22050;
    const seconds = Math.min(20, Math.max(1, duration || 1));
    const total = Math.floor(sampleRate * seconds);
    const samples = new Int16Array(total);
    const notes = [261.63, 329.63, 392.0, 523.25, 440.0, 349.23, 293.66, 392.0];
    for (let i = 0; i < total; i++) {
      const time = i / sampleRate;
      const beat = Math.floor(time / 0.48);
      const inBeat = (time % 0.48) / 0.48;
      const envelope = Math.exp(-inBeat * 3.2);
      const freq = notes[beat % notes.length] * (Math.floor(beat / notes.length) % 2 ? 2 : 1);
      const value =
        Math.sin(2 * Math.PI * freq * time) * 0.22 * envelope +
        Math.sin(2 * Math.PI * freq * 2 * time) * 0.06 * envelope +
        Math.sin(2 * Math.PI * 130.81 * time) * 0.05;
      samples[i] = Math.max(-32767, Math.min(32767, Math.round(value * 32767)));
    }
    return toWav(samples, sampleRate);
  }

  /* --------------------------------------------------------------- */
  /* Мост                                                            */
  /* --------------------------------------------------------------- */

  load();

  const api = {
    isElectron: false,
    demoMode: true,
    platform: 'browser',

    app: {
      async info() {
        return { version: '1.0', platform: 'browser' };
      },
      close() {
        root.close();
      }
    },

    win: {
      minimize() {},
      toggleMaximize() {},
      close() {
        root.close();
      },
      onMaximizeChange() {},
      onCloseRequested() {}
    },

    settings: {
      async get() {
        return Object.assign({}, store.settings);
      },
      async set(patch) {
        store.settings = Object.assign({}, store.settings, patch || {});
        persist();
        return Object.assign({}, store.settings);
      },
      async chooseFolder() {
        const answer = root.prompt('Папка для сохранения записей (демо)', store.settings.saveDir);
        if (answer) {
          store.settings.saveDir = answer;
          persist();
          return answer;
        }
        return null;
      }
    },

    rec: {
      async begin(payload) {
        const id = uid();
        const tracks = new Map();
        for (const track of (payload && payload.tracks) || []) {
          tracks.set(track.id, []);
        }
        sessions.set(id, { tracks, startedAt: new Date().toISOString(), bytes: 0 });
        lastSessionId = id;
        return { sessionId: id };
      },
      async chunk(payload) {
        const session = sessions.get(payload.sessionId);
        if (!session) return;
        const list = session.tracks.get(payload.trackId);
        if (!list) return;
        const data = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
        list.push(data);
        session.bytes += data.length;
      },
      async end(payload) {
        const session = sessions.get(payload.sessionId);
        if (!session) return { tracks: [] };
        const tracks = [];
        for (const [trackId, chunks] of session.tracks) {
          const size = chunks.reduce((sum, part) => sum + part.length, 0);
          tracks.push({ id: trackId, role: trackId, path: DEMO_DIR + '\\demo.mp3', size });
        }
        session.ended = true;
        return { tracks };
      },
      async save(payload) {
        const session = sessions.get(payload.sessionId);
        const stamp = stampName(payload.startedAt);
        const mode = payload.mode || store.settings.mode;
        const id = uid();
        const files = [];
        const parts = [];

        if (session) {
          for (const [trackId, chunks] of session.tracks) {
            if (!chunks.length) continue;
            parts.push(...chunks);
            const suffix = trackId === 'mic' ? ' (микрофон)' : trackId === 'system' ? ' (компьютер)' : '';
            files.push({ path: DEMO_DIR + '\\' + stamp + suffix + '.mp3', role: trackId });
          }
        }

        const blob = new Blob(parts, { type: 'audio/mpeg' });
        if (!blob.size) {
          files.push({ path: DEMO_DIR + '\\' + stamp + '.mp3', role: 'mixed' });
        }
        blobs.set(id, blob);

        const entry = {
          id,
          name: stamp,
          createdAt: payload.startedAt || new Date().toISOString(),
          duration: payload.duration || 0,
          mode,
          size: blob.size,
          files
        };
        store.recordings.unshift(entry);
        store.recordings = store.recordings.slice(0, 30);
        persist();
        if (session) sessions.delete(payload.sessionId);
        return entry;
      },
      async discard(payload) {
        sessions.delete(payload.sessionId);
      }
    },

    recordings: {
      async list() {
        return store.recordings.slice();
      },
      async read(id) {
        const entry = store.recordings.find((item) => item.id === id);
        const blob = blobs.get(id);
        if (blob && blob.size) {
          return { data: new Uint8Array(await blob.arrayBuffer()), mime: 'audio/mpeg' };
        }
        return {
          data: synthMelody(entry ? entry.duration : 3),
          mime: 'audio/wav'
        };
      },
      async reveal(id) {
        notify('Демо: файлы хранятся в памяти браузера, папки на диске нет');
      },
      async openFolder() {
        notify('Демо: файлы хранятся в памяти браузера, папки на диске нет');
      },
      async remove(id) {
        store.recordings = store.recordings.filter((item) => item.id !== id);
        blobs.delete(id);
        persist();
        return true;
      }
    },

    dialog: {
      async unsavedClose() {
        const save = root.confirm('Сохранить текущую запись перед выходом?');
        if (save) return 'save';
        const discard = root.confirm('Выйти без сохранения?');
        return discard ? 'discard' : 'cancel';
      },
      async confirmDelete(entry) {
        return root.confirm('Удалить запись «' + entry.name + '» из демо-списка?');
      }
    }
  };

  root.dictofon = api;
  void lastSessionId;
})(window);
