/*
 * Dictofon — логика окна: запись, пауза, сохранение, список и настройки.
 */
(function () {
  'use strict';

  const bridge = window.dictofon || null;
  const UI = window.DictoUI;
  const U = window.DictoUtil;
  const MODES = window.DictoMix.MODES;

  const DEFAULT_SETTINGS = {
    micDeviceId: 'default',
    micGain: 1,
    sysGain: 1,
    mode: 'mix',
    bitRate: 192,
    captureSystem: true,
    saveDir: ''
  };

  const MIN_DURATION = 0.35;
  const PUSH_INTERVAL = 95;
  const METER_INTERVAL = 33;

  const state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    recordings: [],
    devices: [],
    phase: 'idle',
    engine: null,
    hasContent: false,
    saveBusy: false,
    saveDuration: 0,
    discardArmed: false,
    discardTimer: null,
    sheetOpen: false,
    preview: null,
    deviceError: '',
    pendingSettings: {},
    playing: { id: null, audio: null, url: null },
    closeAfterSave: false,
    lastPush: 0,
    lastMeter: 0,
    lastTimer: ''
  };

  let wave = null;

  /* ------------------------------------------------------------------ */
  /* Инициализация                                                       */
  /* ------------------------------------------------------------------ */

  function init() {
    UI.init();
    const isElectron = !!(bridge && bridge.isElectron);
    UI.setElectron(isElectron, bridge ? bridge.platform : '');
    UI.setDemo(!!(bridge && bridge.demoMode));

    if (!bridge) {
      UI.setHint('Это окно должно открываться внутри приложения Dictofon.', true);
      return;
    }

    wave = new window.DictoWaveform(UI.refs.wave);
    bindEvents();
    setPhase('idle');

    bridge.settings.get()
      .then((settings) => {
        state.settings = normalizeSettings(settings);
        UI.setBadge(state.settings.mode, state.settings.bitRate);
        UI.renderSettings(state.settings, state.devices, settingsMeta());
      })
      .catch(() => {
        UI.renderSettings(state.settings, state.devices, settingsMeta());
      })
      .then(() => refreshDevices(false))
      .then(() => refreshRecordings())
      .catch(() => {});

    if (bridge.app && typeof bridge.app.info === 'function') {
      bridge.app.info().then((info) => {
        UI.setVersion(info && info.version ? info.version : '1.0');
      }).catch(() => {});
    }

    if (isElectron) {
      bridge.win.onMaximizeChange((value) => UI.setMaximized(value));
      bridge.win.onCloseRequested(() => handleCloseRequested());
      UI.refs.btnMin.addEventListener('click', () => bridge.win.minimize());
      UI.refs.btnMax.addEventListener('click', () => bridge.win.toggleMaximize());
      UI.refs.btnClose.addEventListener('click', () => bridge.win.close());
    }

    requestAnimationFrame(frame);
  }

  function normalizeSettings(raw) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    settings.micGain = isFinite(settings.micGain) ? U.clamp(Number(settings.micGain), 0, 2) : 1;
    settings.sysGain = isFinite(settings.sysGain) ? U.clamp(Number(settings.sysGain), 0, 2) : 1;
    settings.mode = MODES[settings.mode] ? settings.mode : 'mix';
    settings.bitRate = [128, 192, 320].includes(Number(settings.bitRate)) ? Number(settings.bitRate) : 192;
    settings.captureSystem = settings.captureSystem !== false;
    settings.micDeviceId = settings.micDeviceId || 'default';
    return settings;
  }

  /* ------------------------------------------------------------------ */
  /* События                                                             */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    UI.refs.btnRecord.addEventListener('click', onRecordClick);
    UI.refs.btnSave.addEventListener('click', () => saveRecording());
    UI.refs.btnDiscard.addEventListener('click', onDiscardClick);

    UI.refs.btnSettings.addEventListener('click', () => {
      if (state.sheetOpen) closeSheet();
      else openSheet();
    });
    UI.refs.btnCloseSettings.addEventListener('click', () => closeSheet());
    UI.refs.backdrop.addEventListener('click', () => closeSheet());

    UI.refs.recList.addEventListener('click', onListClick);

    UI.refs.btnOpenFolder.addEventListener('click', openFolder);
    UI.refs.btnOpenFolder2.addEventListener('click', openFolder);
    UI.refs.btnChooseFolder.addEventListener('click', chooseFolder);

    UI.refs.selMic.addEventListener('change', onDeviceChange);
    UI.refs.btnRefreshMics.addEventListener('click', () => {
      refreshDevices(true).then(() => restartPreview());
    });
    UI.refs.btnTestMic.addEventListener('click', togglePreview);

    UI.refs.swSystem.addEventListener('change', () => {
      if (state.phase !== 'idle') {
        UI.refs.swSystem.checked = state.settings.captureSystem !== false;
        UI.toast('Настройку звука компьютера можно менять до начала записи', 'info');
        return;
      }
      saveSetting({ captureSystem: UI.refs.swSystem.checked });
    });

    UI.refs.rngMic.addEventListener('input', () => {
      const percent = Number(UI.refs.rngMic.value);
      UI.refs.micGainVal.textContent = percent + '%';
      UI.setSliderFill(UI.refs.rngMic);
      saveSetting({ micGain: percent / 100 });
    });
    UI.refs.rngSys.addEventListener('input', () => {
      const percent = Number(UI.refs.rngSys.value);
      UI.refs.sysGainVal.textContent = percent + '%';
      UI.setSliderFill(UI.refs.rngSys);
      saveSetting({ sysGain: percent / 100 });
    });
    UI.refs.rngMic.addEventListener('dblclick', () => saveSetting({ micGain: 1 }));
    UI.refs.rngSys.addEventListener('dblclick', () => saveSetting({ sysGain: 1 }));

    UI.refs.modeGroup.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-mode]');
      if (!button) return;
      if (state.phase !== 'idle') {
        UI.toast('Режим записи можно менять только до её начала', 'info');
        return;
      }
      saveSetting({ mode: button.dataset.mode });
    });

    UI.refs.selBitrate.addEventListener('change', () => {
      if (state.phase !== 'idle') {
        UI.refs.selBitrate.value = String(state.settings.bitRate);
        UI.toast('Качество можно менять только до начала записи', 'info');
        return;
      }
      saveSetting({ bitRate: Number(UI.refs.selBitrate.value) });
    });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', stopPreview);
  }

  function onKeyDown(event) {
    if (event.defaultPrevented) return;
    const target = event.target;
    const tag = target && target.tagName ? target.tagName : '';
    const typing = (tag === 'INPUT' && target.type !== 'range') || tag === 'SELECT' ||
      tag === 'TEXTAREA' || (target && target.isContentEditable);
    // У кнопок и ссылок Space должен работать как обычная активация.
    const interactive = typing || tag === 'BUTTON' || tag === 'A';

    if (event.key === 'Escape') {
      if (state.sheetOpen) {
        event.preventDefault();
        closeSheet();
      } else if (state.discardArmed) {
        event.preventDefault();
        disarmDiscard();
      }
      return;
    }

    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === 's' || event.key === 'S' || event.key === 'ы' || event.key === 'Ы')) {
      event.preventDefault();
      saveRecording();
      return;
    }

    if (event.code === 'Space' && !interactive && !state.sheetOpen) {
      event.preventDefault();
      onRecordClick();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Запись                                                              */
  /* ------------------------------------------------------------------ */

  function setPhase(phase) {
    state.phase = phase;
    if (wave) {
      if (phase === 'recording') wave.setPhase('recording');
      else if (phase === 'paused') wave.setPhase('paused');
      else if (phase === 'saving') wave.setPhase('saving');
      else if (phase === 'idle') wave.setPhase('idle');
    }
    UI.setPhase(phase, {
      hasContent: state.hasContent,
      saveBusy: state.saveBusy,
      discardArmed: state.discardArmed
    });
    updateHint();
  }

  function updateHint() {
    if (state.discardArmed) {
      UI.setHint('Нажмите корзину ещё раз, чтобы <b>удалить</b> запись', true);
      return;
    }
    const hints = {
      idle: '<kbd>Пробел</kbd> — запись и пауза <span class="sep">·</span> <kbd>Ctrl</kbd>+<kbd>S</kbd> — сохранить',
      starting: 'Подключаю микрофон и звук компьютера…',
      recording: '<kbd>Пробел</kbd> — пауза <span class="sep">·</span> «Сохранить» остановит запись',
      paused: '<kbd>Пробел</kbd> — продолжить <span class="sep">·</span> <kbd>Ctrl</kbd>+<kbd>S</kbd> — сохранить',
      saving: 'Сохраняю запись…'
    };
    UI.setHint(hints[state.phase] || hints.idle, false);
  }

  async function onRecordClick() {
    if (state.phase === 'recording') {
      if (state.engine) state.engine.pause();
      setPhase('paused');
      return;
    }
    if (state.phase === 'paused') {
      if (state.engine) state.engine.resume();
      setPhase('recording');
      return;
    }
    if (state.phase !== 'idle') return;
    await startRecording();
  }

  async function startRecording() {
    if (!bridge || state.phase !== 'idle') return;
    if (typeof window.DictoRecorder !== 'function') {
      UI.toast('Аудио-движок не загрузился', 'error');
      return;
    }
    stopPlayback();
    if (state.sheetOpen) closeSheet();
    disarmDiscard();
    state.hasContent = false;
    state.saveDuration = 0;
    setPhase('starting');
    if (wave) wave.reset();

    const engine = new window.DictoRecorder({ bridge, onEvent: onEngineEvent });
    state.engine = engine;

    try {
      const result = await engine.start({
        deviceId: state.settings.micDeviceId,
        captureSystem: state.settings.captureSystem !== false,
        mode: state.settings.mode,
        bitRate: state.settings.bitRate,
        micGain: state.settings.micGain,
        sysGain: state.settings.sysGain
      });
      state.hasContent = true;
      setPhase('recording');
      reportCapture(result);
      refreshMicLabels();
    } catch (err) {
      state.engine = null;
      state.hasContent = false;
      setPhase('idle');
      UI.toast(err && err.message ? err.message : 'Не удалось начать запись', 'error', null, 7000);
    }
  }

  function reportCapture(result) {
    const capture = (result && result.capture) || {};
    if (state.settings.captureSystem && !capture.system) {
      UI.toast('Звук компьютера недоступен — записываю только микрофон', 'info', null, 6000);
    }
    if (!capture.mic) {
      const micError = state.engine && state.engine.errors
        ? state.engine.errors.find((item) => item.source === 'mic')
        : null;
      UI.toast(
        micError ? micError.message : 'Микрофон недоступен — записываю только звук компьютера',
        'info',
        null,
        7000
      );
    }
  }

  function onEngineEvent(type, detail) {
    if (type === 'error') {
      UI.toast((detail && detail.message) || 'Ошибка записи', 'error');
      return;
    }
    if (type === 'system-ended') {
      UI.toast('Захват звука компьютера остановлен. Микрофон записывается дальше.', 'info', null, 6000);
      refreshMicLabels();
    }
  }

  function resetMeters() {
    UI.setMeters(0, 0, {
      micText: '—',
      sysText: '—',
      micOff: false,
      sysOff: state.settings.captureSystem === false
    });
  }

  function refreshMicLabels() {
    if (!state.engine) {
      resetMeters();
      return;
    }
    const capture = state.engine.capture;
    UI.setMeters(state.engine.levels.mic, state.engine.levels.sys, {
      micText: capture.mic ? dbLabel(state.engine.levels.mic) : 'нет доступа',
      sysText: capture.system ? dbLabel(state.engine.levels.sys) : 'нет доступа',
      micOff: !capture.mic,
      sysOff: !capture.system
    });
  }

  async function saveRecording() {
    if (state.phase !== 'recording' && state.phase !== 'paused') return;
    if (state.saveBusy || !state.engine) return;
    const engine = state.engine;
    const duration = engine.duration;

    if (duration < MIN_DURATION) {
      await discardNow('Слишком короткая запись — сохранять нечего');
      return;
    }

    state.saveBusy = true;
    state.saveDuration = duration;
    state.discardArmed = false;
    setPhase('saving');

    let stopped = null;
    try {
      stopped = await engine.stop();
      state.engine = null;
      if (!stopped || stopped.empty || !stopped.sessionId) {
        if (stopped && stopped.sessionId) {
          await bridge.rec.discard({ sessionId: stopped.sessionId });
        }
        UI.toast('Запись пустая — сохранять нечего', 'info');
      } else {
        const entry = await bridge.rec.save({
          sessionId: stopped.sessionId,
          duration: stopped.duration,
          startedAt: stopped.startedAt,
          mode: stopped.mode
        });
        await refreshRecordings();
        UI.flashNew(entry.id);
        UI.toast(`Сохранено: ${entry.name}`, 'success', {
          label: 'Открыть папку',
          onClick: openFolder
        });
      }
    } catch (err) {
      state.closeAfterSave = false;
      UI.toast('Не удалось сохранить: ' + (err && err.message ? err.message : err), 'error');
      if (stopped && stopped.sessionId) {
        try {
          await bridge.rec.discard({ sessionId: stopped.sessionId });
        } catch (discardError) {
          // временные файлы могли уже удалиться
        }
      }
    } finally {
      state.saveBusy = false;
      state.saveDuration = 0;
      state.hasContent = false;
      state.engine = null;
      setPhase('idle');
      UI.setTimer('00:00');
      resetMeters();
      if (state.closeAfterSave) {
        state.closeAfterSave = false;
        bridge.app.close();
      }
    }
  }

  async function onDiscardClick() {
    if (!state.hasContent || state.saveBusy) return;
    if (!state.discardArmed) {
      state.discardArmed = true;
      setPhase(state.phase);
      clearTimeout(state.discardTimer);
      state.discardTimer = setTimeout(() => {
        state.discardArmed = false;
        setPhase(state.phase);
      }, 3200);
      return;
    }
    await discardNow('Запись удалена');
  }

  function disarmDiscard() {
    clearTimeout(state.discardTimer);
    state.discardArmed = false;
    setPhase(state.phase);
  }

  async function discardNow(message) {
    clearTimeout(state.discardTimer);
    state.discardArmed = false;
    state.saveBusy = false;
    const engine = state.engine;
    state.engine = null;
    if (engine) {
      try {
        await engine.abort();
      } catch (err) {
        // запись могла уже остановиться
      }
    }
    state.hasContent = false;
    setPhase('idle');
    UI.setTimer('00:00');
    resetMeters();
    if (message) UI.toast(message, 'info');
    if (state.closeAfterSave) {
      state.closeAfterSave = false;
      bridge.app.close();
    }
  }

  async function handleCloseRequested() {
    if (state.saveBusy) {
      UI.toast('Дождитесь окончания сохранения', 'info');
      return;
    }
    if (!state.hasContent) {
      bridge.app.close();
      return;
    }
    let choice = 'cancel';
    try {
      choice = await bridge.dialog.unsavedClose();
    } catch (err) {
      choice = 'cancel';
    }
    if (choice === 'save') {
      state.closeAfterSave = true;
      await saveRecording();
    } else if (choice === 'discard') {
      await discardNow();
      bridge.app.close();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Список записей                                                      */
  /* ------------------------------------------------------------------ */

  async function refreshRecordings() {
    try {
      state.recordings = await bridge.recordings.list();
    } catch (err) {
      state.recordings = [];
    }
    UI.renderList(state.recordings, state.playing.id);
    if (state.playing.id) UI.setPlaying(state.playing.id);
  }

  async function onListClick(event) {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const item = button.closest('.rec-item');
    if (!item) return;
    const id = item.dataset.id;
    const entry = state.recordings.find((record) => record.id === id);
    if (!entry) return;
    const action = button.dataset.act;

    if (action === 'play') {
      await togglePlay(entry);
      return;
    }
    if (action === 'folder') {
      try {
        await bridge.recordings.reveal(id);
      } catch (err) {
        UI.toast('Не удалось открыть папку с файлом', 'error');
      }
      return;
    }
    if (action === 'delete') {
      let confirmed = false;
      try {
        confirmed = await bridge.dialog.confirmDelete(entry);
      } catch (err) {
        confirmed = false;
      }
      if (!confirmed) return;
      try {
        await bridge.recordings.remove(id);
        if (state.playing.id === id) stopPlayback();
        await refreshRecordings();
        UI.toast('Запись удалена в корзину', 'info');
      } catch (err) {
        UI.toast('Не удалось удалить файл: ' + (err && err.message ? err.message : err), 'error');
      }
    }
  }

  async function togglePlay(entry) {
    if (state.phase !== 'idle') {
      UI.toast('Остановите запись, чтобы прослушать файл', 'info');
      return;
    }
    if (state.playing.id === entry.id) {
      stopPlayback();
      return;
    }
    stopPlayback();
    try {
      const file = await bridge.recordings.read(entry.id);
      const blob = new Blob([file.data], { type: file.mime || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      audio.src = url;
      audio.addEventListener('ended', () => stopPlayback());
      audio.addEventListener('error', () => {
        UI.toast('Не удалось воспроизвести запись', 'error');
        stopPlayback();
      });
      audio.addEventListener('timeupdate', () => {
        if (audio.duration > 0) {
          UI.setProgress(entry.id, audio.currentTime / audio.duration);
        }
      });
      state.playing = { id: entry.id, audio, url };
      await audio.play();
      UI.setPlaying(entry.id);
    } catch (err) {
      stopPlayback();
      UI.toast('Не удалось воспроизвести запись: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  function stopPlayback() {
    const current = state.playing;
    state.playing = { id: null, audio: null, url: null };
    if (current.audio) {
      try {
        current.audio.pause();
      } catch (err) {
        // уже остановлено
      }
      current.audio.src = '';
    }
    if (current.url) URL.revokeObjectURL(current.url);
    if (current.id) UI.setPlaying(null);
  }

  async function openFolder() {
    try {
      await bridge.recordings.openFolder();
    } catch (err) {
      UI.toast('Не удалось открыть папку', 'error');
    }
  }

  async function chooseFolder() {
    try {
      const dir = await bridge.settings.chooseFolder();
      if (dir) {
        state.settings.saveDir = dir;
        UI.renderSettings(state.settings, state.devices, settingsMeta());
        UI.toast('Папка сохранения: ' + dir, 'success');
      }
    } catch (err) {
      UI.toast('Не удалось выбрать папку', 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Настройки                                                           */
  /* ------------------------------------------------------------------ */

  function settingsMeta() {
    return {
      active: state.phase !== 'idle',
      previewing: !!state.preview,
      deviceError: state.deviceError
    };
  }

  function saveSetting(patch) {
    Object.assign(state.settings, patch);
    Object.assign(state.pendingSettings, patch);
    persistSettings();
    UI.renderSettings(state.settings, state.devices, settingsMeta());
    UI.setBadge(state.settings.mode, state.settings.bitRate);
    if (state.engine) {
      state.engine.setGains({ micGain: state.settings.micGain, sysGain: state.settings.sysGain });
    }
  }

  const persistSettings = U.debounce(async () => {
    const patch = state.pendingSettings;
    state.pendingSettings = {};
    if (!Object.keys(patch).length) return;
    try {
      await bridge.settings.set(patch);
    } catch (err) {
      // настройки сохранятся в следующий раз
    }
  }, 260);

  async function refreshDevices(requestPermission) {
    if (!window.DictoRecorder || typeof window.DictoRecorder.listMicrophones !== 'function') return;
    try {
      state.devices = await window.DictoRecorder.listMicrophones(!!requestPermission);
      state.deviceError = '';
    } catch (err) {
      state.devices = [];
      state.deviceError = (err && err.message) || 'Не удалось получить список микрофонов';
    }
    UI.renderSettings(state.settings, state.devices, settingsMeta());
  }

  async function onDeviceChange() {
    if (state.phase !== 'idle') {
      UI.renderSettings(state.settings, state.devices, settingsMeta());
      return;
    }
    saveSetting({ micDeviceId: UI.refs.selMic.value });
    await restartPreview();
  }

  function openSheet() {
    state.sheetOpen = true;
    UI.setSheet(true);
    UI.renderSettings(state.settings, state.devices, settingsMeta());
    if (state.phase === 'idle') {
      refreshDevices(true).then(() => startPreview());
    }
  }

  function closeSheet() {
    state.sheetOpen = false;
    UI.setSheet(false);
    stopPreview();
  }

  /* ------------------------------------------------------------------ */
  /* Проверка микрофона                                                  */
  /* ------------------------------------------------------------------ */

  async function startPreview() {
    if (state.preview || state.phase !== 'idle') return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    const deviceId = state.settings.micDeviceId;
    try {
      const audio = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 48000
      };
      if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      state.preview = {
        stream,
        ctx,
        analyser,
        data: new Float32Array(analyser.fftSize),
        level: 0
      };
      state.deviceError = '';
      UI.setMicHint('', false);
      UI.renderSettings(state.settings, state.devices, settingsMeta());
    } catch (err) {
      state.preview = null;
      const message = window.DictoRecorder && window.DictoRecorder.utils
        ? window.DictoRecorder.utils.micErrorMessage(err)
        : (err && err.message) || 'Не удалось открыть микрофон';
      state.deviceError = message;
      UI.setMicHint(message, true);
      UI.renderSettings(state.settings, state.devices, settingsMeta());
    }
  }

  function stopPreview() {
    const preview = state.preview;
    state.preview = null;
    if (preview) {
      try {
        preview.stream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        // поток уже закрыт
      }
      try {
        preview.ctx.close();
      } catch (err) {
        // контекст уже закрыт
      }
    }
    UI.setPreview(0, '—');
    if (state.settings && UI.refs.settings) {
      UI.renderSettings(state.settings, state.devices, settingsMeta());
    }
  }

  async function restartPreview() {
    if (!state.sheetOpen || state.phase !== 'idle') return;
    if (state.preview) {
      const preview = state.preview;
      state.preview = null;
      try {
        preview.stream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        // уже закрыт
      }
      try {
        preview.ctx.close();
      } catch (err) {
        // уже закрыт
      }
    }
    await startPreview();
  }

  function togglePreview() {
    if (state.phase !== 'idle') {
      UI.toast('Проверка микрофона доступна, когда запись не идёт', 'info');
      return;
    }
    if (state.preview) stopPreview();
    else startPreview();
  }

  /* ------------------------------------------------------------------ */
  /* Анимация и уровни                                                   */
  /* ------------------------------------------------------------------ */

  function levelFromRms(value) {
    const db = 20 * Math.log10(value + 1e-8);
    return U.clamp((db + 54) / 54, 0, 1);
  }

  /** Уровень 0..1 → подпись «−23 дБ» (тише −54 дБ показываем как тишину). */
  function dbLabel(level) {
    if (!level || level < 0.02) return 'тишина';
    const db = Math.round(level * 54 - 54);
    return (db < 0 ? '−' + Math.abs(db) : String(db)) + ' дБ';
  }

  function frame(timestamp) {
    requestAnimationFrame(frame);
    const time = timestamp || 0;
    if (wave) wave.draw(time);

    if (state.phase === 'recording' && state.engine) {
      if (time - state.lastPush >= PUSH_INTERVAL) {
        state.lastPush = time;
        wave.push(state.engine.levels.mic, state.engine.levels.sys);
      }
    }

    if (time - state.lastMeter >= METER_INTERVAL) {
      state.lastMeter = time;
      updateMeters();
      updateTimer();
    }
  }

  function updateMeters() {
    if (state.engine && (state.phase === 'recording' || state.phase === 'paused')) {
      const capture = state.engine.capture;
      const levels = state.engine.levels;
      UI.setMeters(levels.mic, levels.sys, {
        micText: capture.mic ? dbLabel(levels.mic) : 'нет доступа',
        sysText: capture.system ? dbLabel(levels.sys) : 'нет доступа',
        micOff: !capture.mic,
        sysOff: !capture.system
      });
      return;
    }
    if (state.preview) {
      const preview = state.preview;
      preview.analyser.getFloatTimeDomainData(preview.data);
      let sum = 0;
      for (let i = 0; i < preview.data.length; i++) sum += preview.data[i] * preview.data[i];
      const rms = Math.sqrt(sum / preview.data.length);
      preview.level = preview.level + (levelFromRms(rms) - preview.level) * (levelFromRms(rms) > preview.level ? 0.5 : 0.12);
      const db = Math.max(-60, Math.min(0, Math.round(20 * Math.log10(rms + 1e-7))));
      const text = rms < 0.0012 ? 'тишина' : db + ' дБ';
      UI.setPreview(preview.level, text);
      UI.setMeters(preview.level, 0, {
        micText: text,
        sysText: '—',
        micOff: false,
        sysOff: state.settings.captureSystem === false
      });
      return;
    }
    UI.setMeters(0, 0, {
      micText: '—',
      sysText: '—',
      micOff: false,
      sysOff: state.settings.captureSystem === false
    });
    if (!state.sheetOpen) UI.setPreview(0, '—');
  }

  function updateTimer() {
    let seconds = 0;
    if (state.phase === 'recording' || state.phase === 'paused') {
      seconds = state.engine ? state.engine.duration : 0;
    } else if (state.phase === 'saving') {
      seconds = state.saveDuration;
    }
    const text = U.formatTimer(seconds);
    if (text !== state.lastTimer) {
      state.lastTimer = text;
      UI.setTimer(text);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.DictoApp = { state, init };
})();
