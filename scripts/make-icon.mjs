/*
 * Генератор иконки приложения: build/icon.png и build/icon.ico.
 * Запуск: node scripts/make-icon.mjs
 */
import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const scale = size / 512;
  ctx.scale(scale, scale);

  const pad = 26;
  const box = 512 - pad * 2;
  const radius = 116;

  ctx.save();
  ctx.shadowColor = 'rgba(186, 30, 58, 0.45)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 14;
  const gradient = ctx.createLinearGradient(pad, pad, 512 - pad, 512 - pad);
  gradient.addColorStop(0, '#ff90a2');
  gradient.addColorStop(0.42, '#ff5269');
  gradient.addColorStop(1, '#e5263f');
  roundRect(ctx, pad, pad, box, box, radius);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.restore();

  // Верхний блик
  const gloss = ctx.createLinearGradient(0, pad, 0, pad + box * 0.62);
  gloss.addColorStop(0, 'rgba(255,255,255,0.34)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  roundRect(ctx, pad + 1.5, pad + 1.5, box - 3, box - 3, radius - 1);
  ctx.fillStyle = gloss;
  ctx.fill();

  // Тонкая внутренняя рамка
  roundRect(ctx, pad + 1.5, pad + 1.5, box - 3, box - 3, radius - 1);
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Микрофон
  ctx.save();
  ctx.translate(256, 262);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Капсула
  roundRect(ctx, -50, -152, 100, 204, 50);
  ctx.fill();

  // Дуга
  ctx.lineWidth = 26;
  ctx.beginPath();
  ctx.arc(0, -52, 118, 0, Math.PI, false);
  ctx.stroke();

  // Ножка и основание
  ctx.beginPath();
  ctx.moveTo(0, 66);
  ctx.lineTo(0, 128);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-66, 128);
  ctx.lineTo(66, 128);
  ctx.stroke();

  // Акцентная внутренняя точка (тёплый блик)
  ctx.beginPath();
  ctx.fillStyle = 'rgba(255, 214, 221, 0.95)';
  ctx.arc(-16, -108, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  return canvas;
}

function png(size) {
  return drawIcon(size).toBuffer('image/png');
}

const sizes = [256, 128, 64, 48, 32, 16];
const images = sizes.map((size) => ({ size, data: png(size) }));

// ICO-контейнер с PNG-кадрами (поддерживается Windows Vista+)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

const entries = Buffer.alloc(16 * images.length);
let offset = 6 + 16 * images.length;
images.forEach((image, index) => {
  const entryOffset = index * 16;
  entries.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset);
  entries.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset + 1);
  entries.writeUInt8(0, entryOffset + 2);
  entries.writeUInt8(0, entryOffset + 3);
  entries.writeUInt16LE(1, entryOffset + 4);
  entries.writeUInt16LE(32, entryOffset + 6);
  entries.writeUInt32LE(image.data.length, entryOffset + 8);
  entries.writeUInt32LE(offset, entryOffset + 12);
  offset += image.data.length;
});

fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([header, entries, ...images.map((i) => i.data)]));
fs.writeFileSync(path.join(buildDir, 'icon.png'), png(512));
fs.writeFileSync(path.join(buildDir, 'icon-256.png'), png(256));

console.log('Иконки: build/icon.ico, build/icon.png');
