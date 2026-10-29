/*
 * Dictofon — визуализация уровня записи (canvas).
 * Спокойная «дышащая» волна в ожидании и живые столбики во время записи.
 */
(function (root) {
  'use strict';

  const CORAL = [255, 79, 102];
  const INDIGO = [106, 123, 255];
  const GRAY = [140, 148, 168];

  function rgba(rgb, alpha) {
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
  }

  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, h / 2, w / 2);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.fill();
  }

  class Waveform {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.phase = 'idle';
      this.history = [];
      this.cssW = 0;
      this.cssH = 0;
      this.dpr = 1;
      this.barW = 4;
      this.gap = 5;
      this.maxHistory = 240;
      this.resize = this.resize.bind(this);
      this.resize();
      if (root.ResizeObserver) {
        this.observer = new ResizeObserver(this.resize);
        this.observer.observe(canvas);
      } else {
        root.addEventListener('resize', this.resize);
      }
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(0, rect.width);
      const height = Math.max(0, rect.height);
      const dpr = Math.min(3, root.devicePixelRatio || 1);
      this.cssW = width;
      this.cssH = height;
      this.dpr = dpr;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      const ctx = this.ctx;
      if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    setPhase(phase) {
      this.phase = phase;
      if (phase === 'idle') this.history = [];
    }

    reset() {
      this.history = [];
    }

    maxBars() {
      const width = this.cssW || 1;
      return Math.max(16, Math.floor((width + this.gap) / (this.barW + this.gap)));
    }

    push(mic, sys) {
      const m = Math.max(0, Math.min(1, Number(mic) || 0));
      const s = Math.max(0, Math.min(1, Number(sys) || 0));
      this.history.push({ mic: m, sys: s });
      const limit = Math.min(this.maxHistory, this.maxBars() + 8);
      if (this.history.length > limit) this.history.splice(0, this.history.length - limit);
    }

    drawBar(x, level, color, alpha, maxHeight) {
      const h = Math.max(3, 3 + Math.pow(level, 0.82) * (maxHeight - 3));
      const y = (this.cssH - h) / 2;
      this.ctx.fillStyle = rgba(color, alpha);
      roundRect(this.ctx, x, y, this.barW, h, this.barW / 2);
    }

    draw(timeMs) {
      const ctx = this.ctx;
      if (!ctx || !this.cssW || !this.cssH) return;
      ctx.clearRect(0, 0, this.cssW, this.cssH);

      const time = (timeMs || 0) / 1000;
      const maxBars = this.maxBars();
      const maxHeight = Math.max(10, this.cssH - 6);
      const step = this.barW + this.gap;

      if (this.phase === 'idle') {
        for (let i = 0; i < maxBars; i++) {
          const waveA = 0.5 + 0.5 * Math.sin(time * 1.15 + i * 0.29);
          const waveB = 0.5 + 0.5 * Math.sin(time * 0.52 + i * 0.13 + 1.7);
          const level = 0.04 + 0.13 * waveA * waveB;
          const alpha = 0.18 + 0.24 * (i / maxBars);
          this.drawBar(i * step, level, GRAY, alpha, maxHeight);
        }
        return;
      }

      const bars = this.history.slice(-maxBars);
      if (!bars.length) return;
      const paused = this.phase === 'paused';
      const saving = this.phase === 'saving' || this.phase === 'starting';
      // Пока волна не заполнила всю ширину — растёт слева направо,
      // затем «уезжает» влево, как лента записи.
      const totalWidth = bars.length * step;
      const offset = totalWidth >= this.cssW ? this.cssW - totalWidth : 0;

      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i];
        const energy = Math.min(1, bar.mic + bar.sys);
        const sysShare = energy > 0.001 ? bar.sys / (bar.mic + bar.sys) : 0;
        const recency = 0.42 + 0.58 * (i / bars.length);
        let color = mix(CORAL, INDIGO, sysShare);
        let alpha = (0.3 + 0.62 * energy) * recency;
        if (paused || saving) {
          color = GRAY;
          alpha *= paused ? 0.55 : 0.32;
        }
        this.drawBar(offset + i * step, energy, color, alpha, maxHeight);
      }
    }
  }

  root.DictoWaveform = Waveform;
})(window);
