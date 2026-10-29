/*
 * Dictofon — AudioWorklet-захват.
 *
 * Вход 0 — микрофон (моно), вход 1 — звук компьютера (loopback, стерео).
 * Процессор накапливает блоки по BLOCK_FRAMES сэмплов и отправляет их в окно
 * приложения, где они смешиваются и кодируются в MP3 в отдельном воркере.
 */
const BLOCK_FRAMES = 2048;

class DictoCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.blockFrames = opts.blockFrames || BLOCK_FRAMES;
    this.running = false;
    this.position = 0;
    this.mic = new Float32Array(this.blockFrames);
    this.sysL = new Float32Array(this.blockFrames);
    this.sysR = new Float32Array(this.blockFrames);
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.cmd === 'start') {
        this.reset();
        this.running = true;
      } else if (data.cmd === 'stop') {
        this.running = false;
      } else if (data.cmd === 'reset') {
        this.reset();
      }
    };
  }

  reset() {
    this.position = 0;
    this.mic.fill(0);
    this.sysL.fill(0);
    this.sysR.fill(0);
  }

  emit() {
    const mic = this.mic;
    const sysL = this.sysL;
    const sysR = this.sysR;
    this.mic = new Float32Array(this.blockFrames);
    this.sysL = new Float32Array(this.blockFrames);
    this.sysR = new Float32Array(this.blockFrames);
    this.position = 0;
    this.port.postMessage(
      { type: 'block', mic, sysL, sysR, frames: this.blockFrames },
      [mic.buffer, sysL.buffer, sysR.buffer]
    );
  }

  process(inputs) {
    if (!this.running) return true;

    const micInput = inputs[0] && inputs[0].length ? inputs[0][0] : null;
    const sysInput = inputs[1] && inputs[1].length ? inputs[1] : null;
    const sysLeft = sysInput ? sysInput[0] : null;
    const sysRight = sysInput ? (sysInput[1] || sysInput[0]) : null;
    const length = (micInput && micInput.length) || (sysLeft && sysLeft.length) || 128;

    for (let i = 0; i < length; i++) {
      const p = this.position;
      this.mic[p] = micInput ? micInput[i] : 0;
      this.sysL[p] = sysLeft ? sysLeft[i] : 0;
      this.sysR[p] = sysRight ? sysRight[i] : 0;
      this.position = p + 1;
      if (this.position >= this.blockFrames) this.emit();
    }
    return true;
  }
}

registerProcessor('dicto-capture', DictoCaptureProcessor);
