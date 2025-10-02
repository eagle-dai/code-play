const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const TARGET_TIME_MS = 4_000;

(async () => {
  const exampleDir = path.resolve(__dirname, '..', 'assets', 'example');
  const entries = await fs.readdir(exampleDir, { withFileTypes: true });
  const animationFiles = entries
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (animationFiles.length === 0) {
    console.error('No animation HTML files found in assets/example');
    process.exit(1);
  }

  let browser;

  try {
    browser = await chromium.launch();
  } catch (error) {
    const message = error?.message || '';

    if (message.includes("Executable doesn't exist")) {
      console.error(
        'Playwright Chromium binary not found. Run "npx playwright install chromium" and retry.'
      );
    } else if (message.includes('Host system is missing dependencies')) {
      console.error(
        'Chromium is missing required system libraries. Install them with "npx playwright install-deps" (or consult Playwright\'s documentation for your platform) and retry.'
      );
    } else {
      console.error('Failed to launch Chromium:', error);
    }

    process.exitCode = 1;
    return;
  }

  try {
    for (const animationFile of animationFiles) {
      const targetPath = path.resolve(exampleDir, animationFile);

      try {
        await fs.access(targetPath);
      } catch (error) {
        console.warn(`Skipping missing animation file at ${targetPath}`);
        continue;
      }

      const context = await browser.newContext({
        viewport: { width: 320, height: 240 },
      });
      const page = await context.newPage();

      try {
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
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
})();
