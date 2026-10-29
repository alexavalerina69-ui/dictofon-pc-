/*
 * Dictofon — слой интерфейса: ссылки на DOM, рендер списка и настроек, тосты.
 */
(function (root) {
  'use strict';

  const U = root.DictoUtil;
  const MODES = root.DictoMix.MODES;

  const SHORT_MODE = { mix: 'Микс', split: 'Раздельно', dual: '2 файла' };

  const STATUS = {
    idle: 'Готов к записи',
    starting: 'Подключаю…',
    recording: 'Идёт запись',
    paused: 'Пауза',
    saving: 'Сохраняю…'
  };

  const PILL_CLASS = {
    idle: '',
    starting: 'is-starting',
    recording: 'is-recording',
    paused: 'is-paused',
    saving: 'is-saving'
  };

  const RECORD_ICON = {
    idle: 'i-record',
    starting: 'i-record',
    recording: 'i-pause',
    paused: 'i-play',
    saving: 'i-record'
  };

  const RECORD_TITLE = {
    idle: 'Начать запись (Пробел)',
    starting: 'Подключение…',
    recording: 'Пауза (Пробел)',
    paused: 'Продолжить (Пробел)',
    saving: 'Сохранение…'
  };

  const ICON_BY_TYPE = { success: 'i-check', error: 'i-alert', info: 'i-info' };

  const refs = {};

  function $(id) {
    return document.getElementById(id);
  }

  function init() {
    const ids = [
      'app', 'demoPill', 'btnSettings', 'winControls', 'btnMin', 'btnMax', 'btnClose',
      'statusPill', 'statusText', 'modeBadge', 'timer', 'wave',
      'micMeter', 'sysMeter', 'micState', 'sysState', 'levelMic', 'levelSys',
      'btnSave', 'saveLabel', 'btnRecord', 'recIcon', 'btnDiscard', 'hint',
      'recList', 'btnOpenFolder',
      'backdrop', 'settings', 'btnCloseSettings',
      'selMic', 'btnRefreshMics', 'btnTestMic', 'testMicLabel', 'previewMeter', 'previewText', 'micHint',
      'swSystem', 'rngMic', 'rngSys', 'micGainVal', 'sysGainVal',
      'modeGroup', 'modeHint', 'selBitrate', 'folderPath', 'btnChooseFolder', 'btnOpenFolder2',
      'toasts', 'appVersion'
    ];
    for (const id of ids) refs[id] = $(id);
    refs.recUse = refs.recIcon ? refs.recIcon.querySelector('use') : null;
    refs.appVersion = refs.appVersion || null;
  }

  function icon(name, cls) {
    return `<svg class="icon ${cls || ''}"><use href="#${name}"></use></svg>`;
  }

  /* ------------------------------------------------------------------ */
  /* Тосты                                                               */
  /* ------------------------------------------------------------------ */

  function toast(message, type, action, timeout) {
    if (!refs.toasts) return null;
    const kind = ICON_BY_TYPE[type] ? type : 'info';
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = icon(ICON_BY_TYPE[kind]) + '<span class="toast-msg"></span>';
    el.querySelector('.toast-msg').textContent = message;

    function dismiss() {
      if (el.classList.contains('is-out')) return;
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 240);
    }

    if (action && action.label) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        dismiss();
        if (typeof action.onClick === 'function') action.onClick();
      });
      el.appendChild(button);
    }

    refs.toasts.appendChild(el);
    while (refs.toasts.children.length > 3) {
      refs.toasts.firstElementChild.remove();
    }
    setTimeout(dismiss, timeout || (kind === 'error' ? 6500 : 4200));
    return el;
  }

  /* ------------------------------------------------------------------ */
  /* Состояние записи                                                    */
  /* ------------------------------------------------------------------ */

  function setPhase(phase, options) {
    const opts = options || {};
    const app = refs.app;
    app.classList.remove('phase-idle', 'phase-starting', 'phase-recording', 'phase-paused', 'phase-saving');
    app.classList.add('phase-' + phase);

    refs.statusPill.className = 'pill' + (PILL_CLASS[phase] ? ' ' + PILL_CLASS[phase] : '');
    refs.statusText.textContent = STATUS[phase] || STATUS.idle;

    const record = refs.btnRecord;
    record.classList.toggle('is-recording', phase === 'recording');
    record.classList.toggle('is-paused', phase === 'paused');
    record.classList.toggle('is-starting', phase === 'starting' || phase === 'saving');
    record.disabled = phase === 'starting' || phase === 'saving';
    record.title = RECORD_TITLE[phase] || RECORD_TITLE.idle;
    record.setAttribute('aria-label', RECORD_TITLE[phase] || RECORD_TITLE.idle);
    if (refs.recUse) refs.recUse.setAttribute('href', '#' + (RECORD_ICON[phase] || 'i-record'));

    const save = refs.btnSave;
    save.disabled = !opts.hasContent || !!opts.saveBusy || phase === 'starting';
    save.classList.toggle('is-busy', !!opts.saveBusy);
    refs.saveLabel.textContent = opts.saveBusy ? 'Сохраняю…' : 'Сохранить';

    const discard = refs.btnDiscard;
    const showDiscard = !!opts.hasContent && phase !== 'saving' && phase !== 'starting';
    discard.disabled = !showDiscard;
    discard.classList.toggle('is-visible', showDiscard);
    discard.classList.toggle('is-armed', !!opts.discardArmed);
    discard.title = opts.discardArmed ? 'Нажмите ещё раз, чтобы удалить' : 'Удалить запись';
  }

  function setHint(html, warning) {
    if (!refs.hint) return;
    refs.hint.innerHTML = html;
    refs.hint.classList.toggle('is-warning', !!warning);
  }

  function setTimer(text) {
    if (refs.timer && refs.timer.textContent !== text) refs.timer.textContent = text;
  }

  function setMeters(mic, sys, options) {
    const opts = options || {};
    const micPct = U.clamp((mic || 0) * 100, 0, 100).toFixed(1) + '%';
    const sysPct = U.clamp((sys || 0) * 100, 0, 100).toFixed(1) + '%';
    if (refs.micMeter.style.width !== micPct) refs.micMeter.style.width = micPct;
    if (refs.sysMeter.style.width !== sysPct) refs.sysMeter.style.width = sysPct;
    if (opts.micText != null && refs.micState.textContent !== opts.micText) {
      refs.micState.textContent = opts.micText;
    }
    if (opts.sysText != null && refs.sysState.textContent !== opts.sysText) {
      refs.sysState.textContent = opts.sysText;
    }
    refs.levelMic.classList.toggle('is-off', !!opts.micOff);
    refs.levelSys.classList.toggle('is-off', !!opts.sysOff);
    refs.micMeter.parentElement.classList.toggle('is-off', !!opts.micOff);
    refs.sysMeter.parentElement.classList.toggle('is-off', !!opts.sysOff);
  }

  function setBadge(mode, bitRate) {
    if (!refs.modeBadge) return;
    const meta = MODES[mode] || MODES.mix;
    refs.modeBadge.textContent = `${SHORT_MODE[mode] || 'Микс'} · MP3 ${bitRate}`;
    refs.modeBadge.title = meta.description;
  }

  /* ------------------------------------------------------------------ */
  /* Список записей                                                      */
  /* ------------------------------------------------------------------ */

  function fileTitle(entry) {
    if (entry.files && entry.files.length) {
      const name = entry.files[0].path.split(/[\\/]/).pop();
      return name;
    }
    return entry.name || '';
  }

  function renderList(entries, playingId) {
    if (!refs.recList) return;
    if (!entries || !entries.length) {
      refs.recList.innerHTML = `
        <div class="empty">
          <div class="empty-icon">${icon('i-wave')}</div>
          <h3>Пока пусто</h3>
          <p>Нажмите красную кнопку,<br>чтобы начать запись</p>
        </div>`;
      return;
    }
    const html = entries.map((entry) => {
      const files = entry.files || [];
      const extra = files.length > 1 ? `${files.length} файла · ` : '';
      const meta = `${U.formatDurationMeta(entry.duration)} · ${extra}${U.formatBytes(entry.size)}`;
      const mode = SHORT_MODE[entry.mode] || 'Микс';
      const isPlaying = playingId === entry.id;
      return `
        <div class="rec-item${isPlaying ? ' playing' : ''}" data-id="${U.escapeHtml(entry.id)}">
          <button class="play-btn" data-act="play" title="${isPlaying ? 'Пауза' : 'Прослушать'}">
            ${icon(isPlaying ? 'i-pause' : 'i-play')}
          </button>
          <div class="rec-main">
            <div class="rec-name" title="${U.escapeHtml(fileTitle(entry))}">${U.escapeHtml(U.formatWhen(entry.createdAt))}</div>
            <div class="rec-meta">${U.escapeHtml(meta)} · ${U.escapeHtml(mode)}</div>
          </div>
          <div class="rec-actions">
            <button class="rec-action" data-act="folder" title="Показать в папке">${icon('i-folder')}</button>
            <button class="rec-action" data-act="delete" title="Удалить файл">${icon('i-trash')}</button>
          </div>
          <div class="rec-progress"><i></i></div>
        </div>`;
    }).join('');
    refs.recList.innerHTML = html;
  }

  function setPlaying(id) {
    if (!refs.recList) return;
    for (const item of refs.recList.querySelectorAll('.rec-item')) {
      const isPlaying = item.dataset.id === id;
      item.classList.toggle('playing', isPlaying);
      const button = item.querySelector('.play-btn');
      if (button) {
        button.title = isPlaying ? 'Пауза' : 'Прослушать';
        const use = button.querySelector('use');
        if (use) use.setAttribute('href', isPlaying ? '#i-pause' : '#i-play');
        if (!isPlaying) {
          const fill = item.querySelector('.rec-progress > i');
          if (fill) fill.style.width = '0%';
        }
      }
    }
  }

  function setProgress(id, fraction) {
    if (!refs.recList) return;
    const item = refs.recList.querySelector(`.rec-item[data-id="${id}"]`);
    if (!item) return;
    const fill = item.querySelector('.rec-progress > i');
    if (fill) fill.style.width = U.clamp(fraction * 100, 0, 100).toFixed(1) + '%';
  }

  function flashNew(id) {
    if (!refs.recList) return;
    const item = refs.recList.querySelector(`.rec-item[data-id="${id}"]`);
    if (!item) return;
    item.classList.add('is-new');
    setTimeout(() => item.classList.remove('is-new'), 1500);
  }

  /* ------------------------------------------------------------------ */
  /* Настройки                                                           */
  /* ------------------------------------------------------------------ */

  function setSliderFill(range) {
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 100;
    const value = Number(range.value) || 0;
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    range.style.setProperty('--fill', pct.toFixed(1) + '%');
  }

  function renderSettings(settings, devices, options) {
    const opts = options || {};
    if (!settings) return;

    // Микрофоны
    const list = [{ id: 'default', label: 'Микрофон по умолчанию' }].concat(devices || []);
    const current = settings.micDeviceId || 'default';
    const exists = list.some((device) => device.id === current);
    const optionsHtml = list.map((device) => {
      const selected = device.id === (exists ? current : 'default');
      return `<option value="${U.escapeHtml(device.id)}"${selected ? ' selected' : ''}>${U.escapeHtml(device.label)}</option>`;
    }).join('');
    if (refs.selMic.innerHTML !== optionsHtml) refs.selMic.innerHTML = optionsHtml;

    const active = !!opts.active;
    refs.selMic.disabled = active;
    refs.btnRefreshMics.disabled = active;
    refs.swSystem.disabled = active;
    refs.selBitrate.disabled = active;
    for (const button of refs.modeGroup.querySelectorAll('button')) {
      button.disabled = active;
    }

    refs.swSystem.checked = settings.captureSystem !== false;

    refs.rngMic.value = String(Math.round(settings.micGain * 100));
    refs.micGainVal.textContent = Math.round(settings.micGain * 100) + '%';
    setSliderFill(refs.rngMic);

    refs.rngSys.value = String(Math.round(settings.sysGain * 100));
    refs.sysGainVal.textContent = Math.round(settings.sysGain * 100) + '%';
    setSliderFill(refs.rngSys);

    const mode = MODES[settings.mode] ? settings.mode : 'mix';
    for (const button of refs.modeGroup.querySelectorAll('button')) {
      button.setAttribute('aria-checked', String(button.dataset.mode === mode));
    }
    refs.modeHint.textContent = MODES[mode].description;

    refs.selBitrate.value = String(settings.bitRate || 192);
    refs.folderPath.textContent = settings.saveDir || '';
    refs.folderPath.title = settings.saveDir || '';

    setMicHint(opts.deviceError || '', !!opts.deviceError);
    if (!opts.deviceError && active) {
      setMicHint('Сменить микрофон можно после остановки записи.', false);
    }

    refs.btnTestMic.disabled = active;
    refs.testMicLabel.textContent = opts.previewing ? 'Стоп' : 'Проверить';
    refs.btnTestMic.classList.toggle('is-active', !!opts.previewing);
    if (!active && !opts.previewing) {
      refs.previewMeter.style.width = '0%';
      refs.previewText.textContent = '—';
    }
    if (active) {
      refs.previewMeter.style.width = '0%';
      refs.previewText.textContent = '—';
    }
  }

  function setMicHint(text, isError) {
    if (!refs.micHint) return;
    refs.micHint.textContent = text || '';
    refs.micHint.classList.toggle('error', !!isError);
    refs.micHint.hidden = !text;
  }

  function setPreview(level, text) {
    if (!refs.previewMeter) return;
    refs.previewMeter.style.width = U.clamp((level || 0) * 100, 0, 100).toFixed(1) + '%';
    if (text != null) refs.previewText.textContent = text;
  }

  /* ------------------------------------------------------------------ */
  /* Окно, шторка, темы                                                  */
  /* ------------------------------------------------------------------ */

  function setSheet(open) {
    refs.settings.classList.toggle('open', !!open);
    refs.settings.setAttribute('aria-hidden', String(!open));
    refs.backdrop.classList.toggle('open', !!open);
    refs.btnSettings.classList.toggle('active', !!open);
  }

  function setMaximized(value) {
    document.body.classList.toggle('is-max', !!value);
    const use = refs.btnMax ? refs.btnMax.querySelector('use') : null;
    if (use) use.setAttribute('href', value ? '#i-restore' : '#i-max');
    if (refs.btnMax) refs.btnMax.title = value ? 'Восстановить' : 'Развернуть';
  }

  function setElectron(isElectron, platform) {
    document.body.classList.toggle('no-electron', !isElectron);
    document.documentElement.classList.toggle('browser', !isElectron);
    document.body.classList.toggle('is-mac', platform === 'darwin');
  }

  function setDemo(isDemo) {
    if (refs.demoPill) refs.demoPill.hidden = !isDemo;
  }

  function setVersion(version) {
    if (refs.appVersion) refs.appVersion.textContent = version || '1.0';
  }

  root.DictoUI = {
    init,
    refs,
    icon,
    toast,
    setPhase,
    setHint,
    setTimer,
    setMeters,
    setBadge,
    renderList,
    setPlaying,
    setProgress,
    flashNew,
    renderSettings,
    setMicHint,
    setPreview,
    setSliderFill,
    setSheet,
    setMaximized,
    setElectron,
    setDemo,
    setVersion
  };
})(window);
