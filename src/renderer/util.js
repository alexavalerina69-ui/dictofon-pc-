/*
 * Dictofon — небольшие утилиты форматирования.
 */
(function (root) {
  'use strict';

  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  function pad(value) {
    return value < 10 ? '0' + value : String(value);
  }

  /** 5 → 00:05, 65 → 01:05, 3725 → 1:02:05 */
  function formatTimer(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
    return `${pad(minutes)}:${pad(secs)}`;
  }

  /** 5.4 → 00:05 для метаданных, с часами при необходимости */
  function formatDurationMeta(seconds) {
    return formatTimer(Math.round(seconds || 0));
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + ' Б';
    const units = ['КБ', 'МБ', 'ГБ'];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    const digits = size < 10 ? 1 : 0;
    return size.toFixed(digits).replace('.', ',') + ' ' + units[unit];
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function timeOf(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  /** «сегодня, 19:42», «вчера, 09:05», «29 окт., 18:12» */
  function formatWhen(iso, now) {
    const date = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const today = now || new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    if (sameDay(date, today)) return 'сегодня, ' + timeOf(date);
    if (sameDay(date, yesterday)) return 'вчера, ' + timeOf(date);
    const day = date.getDate() + ' ' + MONTHS[date.getMonth()] + '.';
    const year = date.getFullYear() !== today.getFullYear() ? ' ' + date.getFullYear() : '';
    return `${day}${year}, ${timeOf(date)}`;
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function uid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function debounce(fn, ms) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function truncateMiddle(text, max) {
    const value = String(text || '');
    if (value.length <= max) return value;
    const keep = Math.floor((max - 1) / 2);
    return value.slice(0, keep) + '…' + value.slice(-keep);
  }

  const api = {
    formatTimer,
    formatDurationMeta,
    formatBytes,
    formatWhen,
    clamp,
    uid,
    escapeHtml,
    debounce,
    truncateMiddle
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DictoUtil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
