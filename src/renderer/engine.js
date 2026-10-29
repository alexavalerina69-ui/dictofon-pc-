/*
 * Dictofon — движок записи.
 *
 * Захват: AudioWorklet (микрофон + loopback-звук компьютера).
 * Кодирование: Web Worker + lamejs; готовые MP3-чанки сразу уходят в главный
 * процесс и дописываются в файл, поэтому длинные записи не копятся в памяти.
 */
(function (root) {
  'use strict';

  const TARGET_SAMPLE_RATE = 48000;
  const BLOCK_FRAMES = 2048;
  const FLUSH_TIMEOUT = 8000;
  const DRAIN_DELAY = 160;
  const DEMO_INTERVAL = (BLOCK_FRAMES / TARGET_SAMPLE_RATE) * 1000;

  const MESSAGES = {
    denied: 'Нет доступа к микрофону. Разрешите его в «Параметры Windows → Конфиденциальность → Микрофон» и повторите.',
    notFound: 'Микрофон не найден. Подключите устройство или выберите другое в настройках.',
    busy: 'Микрофон занят другой программой. Закройте её и попробуйте снова.',
    generic: 'Не удалось начать запись с микрофона.'
  };

  function micErrorMessage(err) {
    const name = err && err.name ? err.name : '';
    const message = (err && err.message) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError' || /Permission denied/i.test(message)) {
      return MESSAGES.denied;
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || /Requested device not found/i.test(message)) {
      return MESSAGES.notFound;
    }
    if (name === 'NotReadableError' || name === 'AbortError' || /Could not start audio source/i.test(message)) {
      return MESSAGES.busy;
    }
    return message || MESSAGES.generic;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function rms(arr, stride) {
    if (!arr || !arr.length) return 0;
    const step = stride || 1;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < arr.length; i += step) {
      sum += arr[i] * arr[i];
      count += 1;
    }
    return count ? Math.sqrt(sum / count) : 0;
  }

  function levelFromRms(value) {
    const db = 20 * Math.log10(value + 1e-8);
    return clamp01((db + 54) / 54);
  }

  function smooth(prev, next, attack, release) {
    const k = next > prev ? attack : release;
    return prev + (next - prev) * k;
  }

  class Recorder {
    constructor(options) {
      const opts = options || {};
      this.bridge = opts.bridge || (root.dictofon || null);
      this.onEvent = opts.onEvent || function () {};
      this.demo = !!opts.demo || !!(this.bridge && this.bridge.demoMode);

      this.phase = 'idle';
      this.frames = 0;
      this.sampleRate = TARGET_SAMPLE_RATE;
      this.levels = { mic: 0, sys: 0 };
      this.config = {
        deviceId: 'default',
        captureSystem: true,
        mode: 'mix',
        bitRate: 192,
        micGain: 1,
        sysGain: 1
      };
      this.capture = { mic: false, system: false };
      this.errors = [];
      this.warnings = [];

      this.ctx = null;
      this.node = null;
      this.mute = null;
      this.micSource = null;
      this.sysSource = null;
      this.micStream = null;
      this.systemStream = null;
      this.worker = null;
      this.sessionId = null;
      this.startedAt = null;
      this.writeChain = Promise.resolve();
      this.writeError = null;
      this.bytesByTrack = Object.create(null);
      this.demoTimer = null;
      this.demoTime = 0;
      this.expectedFlush = 1;
      this.flushedTracks = 0;
      this.flushResolve = null;
      this.workerResolve = null;
    }

    get isActive() {
      return this.phase === 'recording' || this.phase === 'paused';
    }

    get duration() {
      return this.sampleRate ? this.frames / this.sampleRate : 0;
    }

    setGains(gains) {
      if (!gains) return;
      if (isFinite(gains.micGain)) this.config.micGain = Math.max(0, Math.min(4, gains.micGain));
      if (isFinite(gains.sysGain)) this.config.sysGain = Math.max(0, Math.min(4, gains.sysGain));
    }

    emit(type, detail) {
      try {
        this.onEvent(type, detail || {});
      } catch (err) {
        // обработчик интерфейса не должен ломать запись
      }
    }

    /* ------------------------------------------------------------------ */
    /* Устройства                                                          */
    /* ------------------------------------------------------------------ */

    static async listMicrophones(requestPermission) {
      const md = navigator.mediaDevices;
      if (!md || !md.enumerateDevices) return [];
      if (requestPermission) {
        try {
          const stream = await md.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
          await delay(160);
        } catch (err) {
          throw new Error(micErrorMessage(err));
        }
      }
      const devices = await md.enumerateDevices();
      const list = [];
      const seen = new Set();
      for (const device of devices) {
        if (device.kind !== 'audioinput') continue;
        const key = device.groupId + '::' + device.label;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({
          id: device.deviceId,
          label: device.label || 'Микрофон ' + (list.length + 1)
        });
      }
      return list;
    }

    /* ------------------------------------------------------------------ */
    /* Запуск                                                              */
    /* ------------------------------------------------------------------ */

    async start(config) {
      if (this.isActive || this.phase === 'stopping') {
        throw new Error('Запись уже идёт');
      }
      this.config = Object.assign({}, this.config, config || {});
      this.frames = 0;
      this.levels = { mic: 0, sys: 0 };
      this.errors = [];
      this.warnings = [];
      this.bytesByTrack = Object.create(null);
      this.writeError = null;
      this.writeChain = Promise.resolve();
      this.sessionId = null;
      this.tracks = null;
      this.capture = { mic: false, system: false };
      this.startedAt = new Date().toISOString();

      if (this.demo) return this.startDemo();

      try {
        await this.openAudio();
        await this.openWorker();
        await this.openSession();
        this.armEncoder();
        this.startCapture();
        this.phase = 'recording';
        return { capture: Object.assign({}, this.capture), warnings: this.warnings.slice() };
      } catch (err) {
        this.releaseCapture();
        await this.cleanup(true);
        this.phase = 'idle';
        throw err;
      }
    }

    async openAudio() {
      const AudioCtor = root.AudioContext || root.webkitAudioContext;
      if (!AudioCtor) throw new Error('Аудио не поддерживается в этой системе');

      let ctx;
      try {
        ctx = new AudioCtor({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' });
      } catch (err) {
        ctx = new AudioCtor();
      }
      this.ctx = ctx;
      this.sampleRate = ctx.sampleRate || TARGET_SAMPLE_RATE;
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch (err) {
          // попробуем стартовать дальше — worklet может сам разбудить контекст
        }
      }

      // 1. Звук компьютера (WASAPI loopback через Electron). Запрашиваем первым,
      //    чтобы не потерять «жест пользователя» на системном диалоге.
      let systemStream = null;
      if (this.config.captureSystem) {
        try {
          systemStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          });
          systemStream.getVideoTracks().forEach((track) => track.stop());
          const audioTrack = systemStream.getAudioTracks()[0];
          if (!audioTrack) throw new Error('Системный звук недоступен');
          audioTrack.addEventListener('ended', () => {
            if (!this.isActive) return;
            this.capture.system = false;
            this.emit('system-ended');
          });
        } catch (err) {
          if (systemStream) systemStream.getTracks().forEach((track) => track.stop());
          systemStream = null;
          this.errors.push({
            source: 'system',
            message: 'Не удалось записать звук компьютера. Запись продолжится с микрофона.'
          });
        }
      }
      this.systemStream = systemStream;
      this.capture.system = !!systemStream;

      // 2. Микрофон
      let micStream = null;
      try {
        micStream = await this.openMic();
      } catch (err) {
        this.errors.push({ source: 'mic', message: micErrorMessage(err) });
      }
      this.micStream = micStream;
      this.capture.mic = !!micStream;

      if (!micStream && !systemStream) {
        const micError = this.errors.find((e) => e.source === 'mic');
        throw new Error(micError ? micError.message : 'Нет доступных источников звука');
      }

      if (!ctx.audioWorklet) throw new Error('AudioWorklet не поддерживается');

      // 3. Граф: источники → worklet → «тишина» в выход
      await ctx.audioWorklet.addModule('capture-worklet.js');
      const node = new AudioWorkletNode(ctx, 'dicto-capture', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { blockFrames: BLOCK_FRAMES }
      });
      this.node = node;

      if (micStream) {
        this.micSource = ctx.createMediaStreamSource(micStream);
        this.micSource.connect(node, 0, 0);
      }
      if (systemStream) {
        this.sysSource = ctx.createMediaStreamSource(systemStream);
        this.sysSource.connect(node, 0, 1);
      }

      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);
      this.mute = mute;

      node.port.onmessage = (event) => this.handleBlock(event.data);

      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'suspended' && this.isActive) {
          ctx.resume().catch(() => {});
        }
      });
    }

    async openMic() {
      const md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) throw new Error('Доступ к микрофону не поддерживается');
      const base = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: this.sampleRate
      };
      const deviceId = this.config.deviceId;
      if (deviceId && deviceId !== 'default') {
        try {
          return await md.getUserMedia({ audio: Object.assign({}, base, { deviceId: { exact: deviceId } }) });
        } catch (err) {
          const name = err && err.name ? err.name : '';
          if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw err;
          this.warnings.push('Выбранный микрофон не найден — использую микрофон по умолчанию.');
        }
      }
      return md.getUserMedia({ audio: base });
    }

    async openWorker() {
      this.worker = new Worker('encoder-worker.js');
      this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);
      this.worker.onerror = (event) => {
        this.emit('error', { message: 'Ошибка кодировщика MP3: ' + (event.message || 'неизвестно') });
      };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.workerResolve = null;
          reject(new Error('Кодировщик не запустился'));
        }, 5000);
        this.workerResolve = () => {
          clearTimeout(timer);
          resolve();
        };
        this.worker.postMessage({
          type: 'init',
          sampleRate: this.sampleRate,
          bitRate: this.config.bitRate,
          mode: this.config.mode
        });
      });
    }

    async openSession() {
      const tracks = root.DictoMix.tracksForMode(this.config.mode).map((track) => ({
        id: track.id,
        ext: 'mp3'
      }));
      const res = await this.bridge.rec.begin({ tracks });
      this.sessionId = res.sessionId;
      this.tracks = tracks;
    }

    armEncoder() {
      const tracks = root.DictoMix.tracksForMode(this.config.mode);
      this.expectedFlush = tracks.length;
      this.flushedTracks = 0;
    }

    startCapture() {
      if (this.node) this.node.port.postMessage({ cmd: 'start' });
    }

    /* ------------------------------------------------------------------ */
    /* Блоки и запись на диск                                              */
    /* ------------------------------------------------------------------ */

    handleBlock(data) {
      if (!data || data.type !== 'block') return;
      const { mic, sysL, sysR } = data;
      const frames = data.frames || BLOCK_FRAMES;

      const micRaw = rms(mic, 4);
      const sysRaw = Math.max(rms(sysL, 4), rms(sysR, 4));
      this.levels.mic = smooth(this.levels.mic, levelFromRms(micRaw), 0.55, 0.12);
      this.levels.sys = smooth(this.levels.sys, levelFromRms(sysRaw), 0.55, 0.12);

      const accepting = this.phase === 'recording' || this.phase === 'stopping';
      if (!accepting) return;

      this.frames += frames;
      if (!this.worker) return;
      this.worker.postMessage(
        {
          type: 'block',
          mic,
          sysL,
          sysR,
          frames,
          micGain: this.config.micGain,
          sysGain: this.config.sysGain
        },
        [mic.buffer, sysL.buffer, sysR.buffer]
      );
    }

    handleWorkerMessage(msg) {
      if (!msg) return;
      if (msg.type === 'ready') {
        if (this.workerResolve) {
          const resolve = this.workerResolve;
          this.workerResolve = null;
          resolve();
        }
        return;
      }
      if (msg.type === 'chunk') {
        this.queueWrite(msg.trackId, msg.data);
        return;
      }
      if (msg.type === 'done') {
        this.flushedTracks += 1;
        if (this.flushedTracks >= this.expectedFlush && this.flushResolve) {
          const resolve = this.flushResolve;
          this.flushResolve = null;
          resolve();
        }
        return;
      }
      if (msg.type === 'error') {
        this.emit('error', { message: msg.message || 'Ошибка кодировщика MP3' });
      }
    }

    queueWrite(trackId, data) {
      if (!this.sessionId || !data || !data.length) return;
      this.bytesByTrack[trackId] = (this.bytesByTrack[trackId] || 0) + data.length;
      this.writeChain = this.writeChain
        .then(() => this.bridge.rec.chunk({ sessionId: this.sessionId, trackId, data }))
        .catch((err) => {
          if (!this.writeError) {
            this.writeError = err;
            this.emit('error', {
              message: 'Не удалось записать данные на диск: ' + (err && err.message ? err.message : err)
            });
          }
        });
    }

    pause() {
      if (this.phase !== 'recording') return false;
      this.phase = 'paused';
      return true;
    }

    resume() {
      if (this.phase !== 'paused') return false;
      this.phase = 'recording';
      return true;
    }

    /* ------------------------------------------------------------------ */
    /* Остановка                                                           */
    /* ------------------------------------------------------------------ */

    async stop() {
      if (this.phase === 'stopping') return this.stopping;
      if (!this.isActive) return null;
      this.phase = 'stopping';
      const work = this.doStop();
      this.stopping = work;
      try {
        return await work;
      } finally {
        this.stopping = null;
      }
    }

    async doStop() {
      const duration = this.duration;
      const { startedAt } = this;
      const mode = this.config.mode;

      this.stopNode();
      // Даём уже отправленным блокам дойти до окна (хвост ~40 мс).
      await delay(DRAIN_DELAY);
      this.releaseCapture();
      await this.flushEncoder();
      await this.writeChain;

      let info = { tracks: [] };
      if (this.sessionId) {
        try {
          info = await this.bridge.rec.end({ sessionId: this.sessionId, duration });
        } catch (err) {
          this.emit('error', {
            message: 'Не удалось завершить запись: ' + (err && err.message ? err.message : err)
          });
        }
      }

      const sessionId = this.sessionId;
      this.sessionId = null;
      await this.cleanup(false);
      this.phase = 'idle';
      this.frames = 0;
      this.levels = { mic: 0, sys: 0 };

      const tracks = info.tracks || [];
      return {
        sessionId,
        duration,
        startedAt,
        mode,
        tracks,
        empty: duration < 0.05 || !tracks.length || tracks.every((track) => !track.size)
      };
    }

    stopNode() {
      if (!this.node) return;
      try {
        this.node.port.postMessage({ cmd: 'stop' });
      } catch (err) {
        // узел мог быть уже отключён
      }
    }

    releaseCapture() {
      if (this.node) {
        try { this.node.port.onmessage = null; } catch (err) { /* noop */ }
        try { this.node.disconnect(); } catch (err) { /* noop */ }
        this.node = null;
      }
      if (this.micSource) {
        try { this.micSource.disconnect(); } catch (err) { /* noop */ }
        this.micSource = null;
      }
      if (this.sysSource) {
        try { this.sysSource.disconnect(); } catch (err) { /* noop */ }
        this.sysSource = null;
      }
      if (this.mute) {
        try { this.mute.disconnect(); } catch (err) { /* noop */ }
        this.mute = null;
      }
      const stopStream = (stream) => {
        if (!stream) return;
        stream.getTracks().forEach((track) => {
          try { track.stop(); } catch (err) { /* noop */ }
        });
      };
      stopStream(this.micStream);
      stopStream(this.systemStream);
      this.micStream = null;
      this.systemStream = null;
      if (this.demoTimer) {
        clearInterval(this.demoTimer);
        this.demoTimer = null;
      }
      if (this.ctx) {
        const ctx = this.ctx;
        this.ctx = null;
        ctx.close().catch(() => {});
      }
    }

    async flushEncoder() {
      if (!this.worker) return;
      await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => done(), FLUSH_TIMEOUT);
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.flushResolve = null;
          resolve();
        };
        this.flushResolve = done;
        try {
          this.worker.postMessage({ type: 'flush' });
        } catch (err) {
          done();
        }
      });
    }

    async abort() {
      const sessionId = this.sessionId;
      this.stopNode();
      this.releaseCapture();
      this.sessionId = null;
      if (this.worker) {
        try { this.worker.terminate(); } catch (err) { /* noop */ }
        this.worker = null;
      }
      this.phase = 'idle';
      this.frames = 0;
      this.levels = { mic: 0, sys: 0 };
      this.expectedFlush = 1;
      this.flushedTracks = 0;
      if (sessionId) {
        try {
          await this.bridge.rec.discard({ sessionId });
        } catch (err) {
          // временная папка могла уже исчезнуть
        }
      }
    }

    async cleanup(discard) {
      if (this.worker) {
        try { this.worker.terminate(); } catch (err) { /* noop */ }
        this.worker = null;
      }
      if (discard && this.sessionId) {
        const sessionId = this.sessionId;
        this.sessionId = null;
        try {
          await this.bridge.rec.discard({ sessionId });
        } catch (err) {
          // noop
        }
      }
    }

    /* ------------------------------------------------------------------ */
    /* Демо-режим (предпросмотр интерфейса в браузере)                     */
    /* ------------------------------------------------------------------ */

    async startDemo() {
      this.sampleRate = TARGET_SAMPLE_RATE;
      await this.openWorker();
      await this.openSession();
      this.armEncoder();
      this.capture = { mic: true, system: this.config.captureSystem };
      this.phase = 'recording';
      this.demoTime = 0;

      this.demoTimer = setInterval(() => {
        const n = BLOCK_FRAMES;
        const mic = new Float32Array(n);
        const sysL = new Float32Array(n);
        const sysR = new Float32Array(n);
        const t0 = this.demoTime / this.sampleRate;
        const phrase = (Math.sin(t0 * 0.62) + 1) / 2;
        const gate = phrase > 0.3 ? 1 : 0.05;
        for (let i = 0; i < n; i++) {
          const t = t0 + i / this.sampleRate;
          const voice =
            Math.sin(2 * Math.PI * 196 * t) * 0.45 +
            Math.sin(2 * Math.PI * 392 * t + 1.7) * 0.2 +
            Math.sin(2 * Math.PI * 587 * t + 0.4) * 0.1;
          const wobble = 0.7 + 0.3 * Math.sin(2 * Math.PI * 2.4 * t);
          mic[i] = voice * 0.2 * gate * wobble;
          const musicL = Math.sin(2 * Math.PI * 261.6 * t) * 0.12 + Math.sin(2 * Math.PI * 329.6 * t) * 0.08;
          const musicR = Math.sin(2 * Math.PI * 392 * t) * 0.1 + Math.sin(2 * Math.PI * 523.3 * t) * 0.06;
          sysL[i] = musicL * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.2 * t));
          sysR[i] = musicR * (0.6 + 0.4 * Math.cos(2 * Math.PI * 0.17 * t));
        }
        this.demoTime += n;
        this.handleBlock({ type: 'block', mic, sysL, sysR, frames: n });
      }, DEMO_INTERVAL);

      return { capture: Object.assign({}, this.capture), warnings: [] };
    }
  }

  Recorder.utils = { micErrorMessage, rms, levelFromRms, smooth, clamp01 };

  root.DictoRecorder = Recorder;
})(window);
