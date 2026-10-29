/*
 * Dictofon — воркер MP3-энкодера.
 * Получает сырые блоки PCM, смешивает их по режиму и отдаёт MP3-чанки.
 */
/* global importScripts, DictoEncoder, DictoMix */
importScripts('vendor/lame.min.js', 'mix.js', 'encoder.js');

let pipeline = null;

function describeError(err) {
  if (!err) return 'Неизвестная ошибка кодировщика';
  if (err.message) return err.message;
  return String(err);
}

function postChunks(chunks) {
  if (!chunks || !chunks.length) return;
  for (const chunk of chunks) {
    self.postMessage({ type: 'chunk', trackId: chunk.trackId, data: chunk.data }, [chunk.data.buffer]);
  }
}

self.onmessage = (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      pipeline = new DictoEncoder.EncoderPipeline({
        sampleRate: msg.sampleRate || 48000,
        bitRate: msg.bitRate || 192,
        mode: DictoMix.MODES[msg.mode] ? msg.mode : DictoMix.DEFAULT_MODE
      });
      self.postMessage({ type: 'ready', tracks: pipeline.trackIds });
      return;
    }

    if (msg.type === 'block') {
      if (!pipeline) return;
      postChunks(pipeline.push({
        mic: msg.mic,
        sysL: msg.sysL,
        sysR: msg.sysR,
        frames: msg.frames,
        micGain: msg.micGain,
        sysGain: msg.sysGain
      }));
      return;
    }

    if (msg.type === 'flush') {
      if (!pipeline) {
        self.postMessage({ type: 'done', trackId: null });
        return;
      }
      postChunks(pipeline.flush());
      for (const trackId of pipeline.trackIds) {
        self.postMessage({ type: 'done', trackId });
      }
      pipeline = null;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: describeError(err) });
  }
};
