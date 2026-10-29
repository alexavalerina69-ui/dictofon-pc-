/*
 * Скриншоты интерфейса + смоук-тест сценария «запись → сохранение».
 *
 * Запуск:
 *   npm run preview                       (в отдельном терминале)
 *   npm i --no-save puppeteer && node scripts/screenshot.mjs
 *
 * Если браузер уже есть, можно указать путь:
 *   CHROME_PATH=/path/to/chrome node scripts/screenshot.mjs
 * (тогда используется puppeteer-core из пакета puppeteer)
 *
 * Переменные: PREVIEW_URL (по умолчанию http://127.0.0.1:8080),
 *             SCREENSHOT_DPI (по умолчанию 2).
 */
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.PREVIEW_URL || 'http://127.0.0.1:8080';
const dpi = Number(process.env.SCREENSHOT_DPI || 2);
const chromePath = process.env.CHROME_PATH || '';
const outDir = path.join(process.cwd(), 'docs', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

let puppeteer = null;
try {
  puppeteer = (await import('puppeteer')).default;
} catch (err) {
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch (inner) {
    console.error('Нужен puppeteer: npm i --no-save puppeteer  (или задайте CHROME_PATH)');
    process.exit(1);
  }
}

async function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.ok) return true;
    } catch (err) {
      // сервер ещё поднимается
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function shot(page, name) {
  const file = path.join(outDir, name + '.png');
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });
  await page.screenshot({ path: file });
  console.log('Скриншот:', path.relative(process.cwd(), file));
}

async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

if (!(await waitForServer(base + '/index.html'))) {
  console.error('Предпросмотр недоступен:', base);
  process.exit(1);
}

const launchOptions = {
  headless: true,
  defaultViewport: { width: 1060, height: 720, deviceScaleFactor: dpi },
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    '--font-render-hinting=none'
  ]
};
if (chromePath) launchOptions.executablePath = chromePath;

const browser = await puppeteer.launch(launchOptions);
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message));

await page.goto(base + '/index.html', { waitUntil: 'load', timeout: 30000 });
await page.waitForSelector('#btnRecord');
await pause(700);

// Как в Electron: показываем системные кнопки окна и убираем плашку «демо»
await page.evaluate(() => {
  document.body.classList.remove('no-electron');
  const pill = document.getElementById('demoPill');
  if (pill) pill.hidden = true;
});

await shot(page, 'idle');

// Запись: демо-источники + настоящий MP3-энкодер
await page.click('#btnRecord');
await page.waitForFunction(() => window.DictoApp && window.DictoApp.state.phase === 'recording', {
  timeout: 15000
});
await pause(2100);
await shot(page, 'recording');

const timerText = await page.$eval('#timer', (el) => el.textContent);
const recordClock = await page.evaluate(() => window.DictoApp.state.engine.duration);

// Пауза (для скриншота не нужна, проверяем состояние)
await page.click('#btnRecord');
await page.waitForFunction(() => window.DictoApp.state.phase === 'paused', { timeout: 5000 });
await page.click('#btnRecord');
await page.waitForFunction(() => window.DictoApp.state.phase === 'recording', { timeout: 5000 });

// Сохранение
await page.click('#btnSave');
await page.waitForFunction(() => window.DictoApp.state.phase === 'idle', { timeout: 25000 });
await page.waitForSelector('.rec-item', { timeout: 25000 });
await pause(600);
await shot(page, 'main');

const saved = await page.evaluate(() => window.DictoApp.state.recordings.map((item) => ({
  name: item.name,
  duration: item.duration,
  size: item.size,
  roles: item.files.map((file) => file.role)
})));

// Настройки
await page.click('#btnSettings');
await pause(650);
await shot(page, 'settings');
await page.keyboard.press('Escape');
await pause(350);

// Тёмная тема
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await pause(500);
await shot(page, 'dark');
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await pause(300);

// Прослушивание (проверяем, что файл читается)
await page.click('#recList .play-btn');
await pause(600);
const playing = await page.evaluate(() => window.DictoApp.state.playing.id);
await page.evaluate(() => {
  const audio = window.DictoApp.state.playing.audio;
  if (audio) audio.dispatchEvent(new Event('ended'));
});

const report = {
  generatedAt: new Date().toISOString(),
  base,
  viewport: { width: 1060, height: 720, dpi },
  timerText,
  recordClock,
  saved,
  playing: !!playing,
  consoleErrors
};
fs.writeFileSync(path.join(process.cwd(), 'docs', 'report.json'), JSON.stringify(report, null, 2));

await browser.close();

if (!saved.length) {
  console.error('Демо-запись не сохранилась');
  process.exit(1);
}
if (!playing) {
  console.error('Запись не прослушивается');
  process.exit(1);
}
if (consoleErrors.length) {
  console.error('Ошибки в консоли:', consoleErrors);
  process.exit(1);
}
console.log('Готово:', saved.length, 'запись(я),', timerText, 'на таймере,',
  Math.round(recordClock * 10) / 10, 'с аудио,', saved[0].size, 'байт MP3');
