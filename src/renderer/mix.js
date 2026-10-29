/*
 * Dictofon — микширование аудио-блоков.
 *
 * Модуль общий для окна приложения, воркера-энкодера и тестов (Node.js),
 * поэтому написан как обычный классический скрипт (UMD-лайт, без import/export).
 *
 * Режимы записи:
 *   mix    — звук компьютера в стерео + микрофон по центру (одна дорожка)
 *   split  — микрофон в левом канале, компьютер в правом (одна дорожка)
 *   dual   — две отдельные дорожки: микрофон (моно) и компьютер (стерео)
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DictoMix = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODES = {
    mix: {
      id: 'mix',
      title: 'Микс',
      description: 'Звук компьютера в стерео, микрофон по центру — один файл.'
    },
    split: {
      id: 'split',
      title: 'Раздельно',
      description: 'Микрофон в левом канале, компьютер в правом — удобно расшифровывать.'
    },
    dual: {
      id: 'dual',
      title: 'Две дорожки',
      description: 'Два отдельных файла MP3: микрофон и компьютер.'
    }
  };

  const DEFAULT_MODE = 'mix';
  const MAX_GAIN = 4;

  function toInt16(v) {
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    return Math.round(v * 32767);
  }

  function sample(arr, i) {
    return arr && i < arr.length ? arr[i] : 0;
  }

  function gainsOf(gains) {
    const mic = gains && isFinite(gains.micGain) ? Number(gains.micGain) : 1;
    const sys = gains && isFinite(gains.sysGain) ? Number(gains.sysGain) : 1;
    return {
      mic: Math.min(MAX_GAIN, Math.max(0, mic)),
      sys: Math.min(MAX_GAIN, Math.max(0, sys))
    };
  }

  /**
   * Готовит Int16-блоки нужного вида для энкодера.
   * @param {{mode?:string, mic?:Float32Array, sysL?:Float32Array, sysR?:Float32Array,
   *          frames:number, micGain?:number, sysGain?:number}} block
   * @returns {{stereo?:Int16Array[], mic?:Int16Array[], system?:Int16Array[]}}
   */
  function mixBlock(block) {
    const mode = MODES[block.mode] ? block.mode : DEFAULT_MODE;
    const frames = Math.max(0, block.frames | 0);
    const g = gainsOf(block);
    const { mic, sysL } = block;
    const sysR = block.sysR || block.sysL;
    let i, m;

    if (mode === 'split') {
      const left = new Int16Array(frames);
      const right = new Int16Array(frames);
      for (i = 0; i < frames; i++) {
        m = sample(mic, i) * g.mic;
        left[i] = toInt16(m);
        right[i] = toInt16((sample(sysL, i) * g.sys + sample(sysR, i) * g.sys) * 0.5);
      }
      return { stereo: [left, right] };
    }

    if (mode === 'dual') {
      const micCh = new Int16Array(frames);
      const sysChL = new Int16Array(frames);
      const sysChR = new Int16Array(frames);
      for (i = 0; i < frames; i++) {
        micCh[i] = toInt16(sample(mic, i) * g.mic);
        sysChL[i] = toInt16(sample(sysL, i) * g.sys);
        sysChR[i] = toInt16(sample(sysR, i) * g.sys);
      }
      return { mic: [micCh], system: [sysChL, sysChR] };
    }

    // mix: стерео компьютера + микрофон по центру
    const mixL = new Int16Array(frames);
    const mixR = new Int16Array(frames);
    for (i = 0; i < frames; i++) {
      m = sample(mic, i) * g.mic;
      mixL[i] = toInt16(m + sample(sysL, i) * g.sys);
      mixR[i] = toInt16(m + sample(sysR, i) * g.sys);
    }
    return { stereo: [mixL, mixR] };
  }

  /** Дорожки, которые появятся в файле(ах) для выбранного режима. */
  function tracksForMode(mode) {
    if (mode === 'dual') {
      return [
        { id: 'mic', channels: 1, role: 'mic', suffix: 'микрофон' },
        { id: 'system', channels: 2, role: 'system', suffix: 'компьютер' }
      ];
    }
    return [{ id: 'stereo', channels: 2, role: 'mixed', suffix: '' }];
  }

  return {
    MODES,
    DEFAULT_MODE,
    MAX_GAIN,
    mixBlock,
    tracksForMode,
    toInt16
  };
});
