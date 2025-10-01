const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const [, , animationFile] = process.argv;

if (!animationFile) {
  console.error(
    'Usage: node scripts/capture-animation-screenshot.js <animation-html-relative-path>'
  );
  console.error('Example: node scripts/capture-animation-screenshot.js css-animation.html');
  process.exit(1);
}

const targetPath = path.resolve(
  __dirname,
  '..',
  'assets',
  'example',
  animationFile
);

const TARGET_TIME_MS = 4_000;

(async () => {
  try {
    await fs.access(targetPath);
  } catch (error) {
    console.error(`Animation file not found at ${targetPath}`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 320, height: 240 },
  });
  const page = await context.newPage();

  const fileUrl = pathToFileURL(targetPath).href;
  await page.goto(fileUrl, { waitUntil: 'load' });

  const client = await context.newCDPSession(page);

  await client.send('Emulation.setVirtualTimePolicy', {
    policy: 'pauseIfNetworkFetchesPending',
    budget: 0,
  });

  await client.send('Emulation.setVirtualTimePolicy', {
    policy: 'pauseIfNetworkFetchesPending',
    budget: TARGET_TIME_MS,
  });

  await page.waitForTimeout(1000);

  // Force CSS animations to their state at the 4-second mark. Some animations
  // keep running indefinitely which can prevent the visual state from ever
  // settling when using virtual time alone, so we explicitly seek them.
  await page.evaluate((targetTimeMs) => {
    const animations = document.getAnimations();
    for (const animation of animations) {
      try {
        animation.currentTime = targetTimeMs;
        animation.pause();
      } catch (error) {
        console.warn('Failed to fast-forward animation', error);
      }
    }
  }, TARGET_TIME_MS);

  const safeName = animationFile
    .replace(/[\\/]/g, '-')
    .replace(/\.html?$/i, '')
    .trim();
  const targetSeconds = Math.round(TARGET_TIME_MS / 1000);
  const screenshotFilename = `${safeName || 'animation'}-${targetSeconds}s.png`;
  const screenshotPath = path.resolve(
    __dirname,
    '..',
    'tmp',
    'output',
    screenshotFilename
  );
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });

  await page.screenshot({
    path: screenshotPath,
  });

  await browser.close();
})();
