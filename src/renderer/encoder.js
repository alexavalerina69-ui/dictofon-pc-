/*
 * Dictofon — MP3-энкодер (LAME/JS).
 *
 * Используется в воркере encoder-worker.js, а также в тестах Node.js.
 * Требует глобальный объект `lamejs` (vendor/lame.min.js).
 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DictoEncoder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const mix = root.DictoMix || (typeof require === 'function' ? require('./mix.js') : null);

  function getLame() {
    if (root.lamejs && root.lamejs.Mp3Encoder) return root.lamejs;
    throw new Error('lamejs не загружен');
  }

  // LAME поддерживает только эти частоты. Если аудиоустройство отдаёт что-то
  // экзотическое, кодируем в ближайшую поддерживаемую, чтобы запись не сорвалась.
  const LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  function createEncoder(channels, sampleRate, bitRate) {
    const lame = getLame();
    const candidates = LAME_RATES.includes(sampleRate)
      ? [sampleRate, 48000, 44100]
      : [48000, 44100];
    let lastError = null;
    for (const rate of candidates) {
      try {
        const encoder = new lame.Mp3Encoder(channels, rate, bitRate);
        return { encoder, rate };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Не удалось создать MP3-энкодер');
  }

  /** Один MP3-поток (моно или стерео). */
  class TrackEncoder {
    constructor(options) {
      const { id, channels, bitRate } = options;
      this.id = id;
      this.channels = channels === 1 ? 1 : 2;
      this.bitRate = bitRate;
      const created = createEncoder(this.channels, options.sampleRate, bitRate);
      this.encoder = created.encoder;
      this.sampleRate = created.rate;
      this.encodeIn = 0;
      this.encodedBytes = 0;
    }

    push(channelsInt16) {
      const left = channelsInt16[0];
      const right = this.channels === 2 ? channelsInt16[1] || channelsInt16[0] : undefined;
      if (!left || !left.length) return null;
      this.encodeIn += left.length;
      const data = this.channels === 1
        ? this.encoder.encodeBuffer(left)
        : this.encoder.encodeBuffer(left, right);
      return this.wrap(data);
    }

    flush() {
      return this.wrap(this.encoder.flush());
    }

    wrap(data) {
      if (!data || !data.length) return null;
      const out = new Uint8Array(data.length);
      out.set(data);
      this.encodedBytes += out.length;
      return out;
    }
  }

  /** Набор дорожек выбранного режима записи. */
  class EncoderPipeline {
    constructor(options) {
      const { sampleRate, bitRate, mode } = options;
      this.mode = mode;
      this.sampleRate = sampleRate;
      this.bitRate = bitRate;
      const tracks = mix.tracksForMode(mode);
      this.encoders = tracks.map((t) => new TrackEncoder({
        id: t.id,
        channels: t.channels,
        sampleRate,
        bitRate: t.id === 'mic' ? Math.min(bitRate, 128) : bitRate
      }));
      this.trackIds = this.encoders.map((e) => e.id);
    }

    /**
     * @param {{mic?:Float32Array, sysL?:Float32Array, sysR?:Float32Array, frames:number,
     *          micGain?:number, sysGain?:number}} block
     * @returns {Array<{trackId:string, data:Uint8Array}>}
     */
    push(block) {
      const mixed = mix.mixBlock({
        mode: this.mode,
        mic: block.mic,
        sysL: block.sysL,
        sysR: block.sysR,
        frames: block.frames,
        micGain: block.micGain,
        sysGain: block.sysGain
      });
      const out = [];
      for (const enc of this.encoders) {
        const pcm = mixed[enc.id];
        if (!pcm) continue;
        const data = enc.push(pcm);
        if (data) out.push({ trackId: enc.id, data });
      }
      return out;
    }

    flush() {
      const out = [];
      for (const enc of this.encoders) {
        const data = enc.flush();
        if (data) out.push({ trackId: enc.id, data });
      }
      return out;
    }

    stats() {
      return this.encoders.map((e) => ({
        trackId: e.id,
        encodedBytes: e.encodedBytes,
        samples: e.encodeIn,
        seconds: this.sampleRate ? e.encodeIn / this.sampleRate : 0,
        encoderRate: e.sampleRate
      }));
    }
  }

  return { TrackEncoder, EncoderPipeline };
});
