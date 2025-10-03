const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const TARGET_TIME_MS = 4_000;
const VIRTUAL_TIME_STEP_MS = 250;
const EXAMPLE_DIR = path.resolve(__dirname, '..', 'assets', 'example');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'tmp', 'output');
const VIEWPORT_DIMENSIONS = { width: 320, height: 240 };
const POST_VIRTUAL_TIME_WAIT_MS = 1_000;
const MEDIA_READY_TIMEOUT_MS = 5_000;
const HTML_FILE_PATTERN = /\.html?$/i;

async function ensureDirectoryAvailable(directoryPath) {
  try {
    await fs.access(directoryPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `Expected directory "${directoryPath}" to exist. Add animation examples under assets/example/.`
      );
    }

    throw error;
  }
}

async function collectAnimationFiles(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && HTML_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function advanceVirtualTime(client, budgetMs) {
  return new Promise((resolve, reject) => {
    const handleBudgetExpired = () => resolve();

    client.once('Emulation.virtualTimeBudgetExpired', handleBudgetExpired);

    client
      .send('Emulation.setVirtualTimePolicy', {
        policy: 'pauseIfNetworkFetchesPending',
        budget: budgetMs,
      })
      .catch((error) => {
        client.off('Emulation.virtualTimeBudgetExpired', handleBudgetExpired);
        reject(error);
      });
  });
}

async function waitForMediaMetadata(page) {
  try {
    await page.waitForFunction(
      () => {
        const videos = Array.from(document.querySelectorAll('video'));
        if (videos.length === 0) {
          return true;
        }

        return videos.every((video) => video.readyState >= HTMLMediaElement.HAVE_METADATA);
      },
      { timeout: MEDIA_READY_TIMEOUT_MS }
    );
  } catch (error) {
    // Continue even if metadata never loads; individual seek operations handle failures.
  }
}

async function freezeDocumentState(page, targetTimeMs) {
  await page.evaluate(async (targetMs) => {
    const targetSeconds = targetMs / 1000;

    const animations = document.getAnimations();
    for (const animation of animations) {
      try {
        animation.currentTime = targetMs;
        animation.pause();
      } catch (error) {
        console.warn('Failed to fast-forward animation', error);
      }
    }

    const videos = Array.from(document.querySelectorAll('video'));
    for (const video of videos) {
      const duration = Number.isFinite(video.duration) ? video.duration : NaN;
      const desiredSeconds = Number.isFinite(duration)
        ? Math.min(targetSeconds, duration)
        : targetSeconds;

      try {
        video.currentTime = desiredSeconds;
      } catch (error) {
        console.warn('Failed to seek video to target time', error);
        continue;
      }

      video.pause();
      video.dispatchEvent(new Event('timeupdate'));
      video.dispatchEvent(new Event('pause'));
    }
  }, targetTimeMs);
}

async function captureAnimationFile(browser, animationFile) {
  const targetPath = path.resolve(EXAMPLE_DIR, animationFile);
  const context = await browser.newContext({ viewport: VIEWPORT_DIMENSIONS });
  const page = await context.newPage();

  try {
    const fileUrl = pathToFileURL(targetPath).href;
    await page.goto(fileUrl, { waitUntil: 'load' });

    await waitForMediaMetadata(page);

    const client = await context.newCDPSession(page);

    await client.send('Emulation.setVirtualTimePolicy', {
      policy: 'pauseIfNetworkFetchesPending',
      budget: 0,
    });

    let elapsed = 0;
    while (elapsed < TARGET_TIME_MS) {
      const remaining = TARGET_TIME_MS - elapsed;
      const step = Math.min(remaining, VIRTUAL_TIME_STEP_MS);
      await advanceVirtualTime(client, step);
      elapsed += step;
    }

    await page.waitForTimeout(POST_VIRTUAL_TIME_WAIT_MS);

    await freezeDocumentState(page, TARGET_TIME_MS);

    const safeName = animationFile
      .replace(/[\\/]/g, '-')
      .replace(HTML_FILE_PATTERN, '')
      .trim();
    const targetSeconds = Math.round(TARGET_TIME_MS / 1000);
    const screenshotFilename = `${safeName || 'animation'}-${targetSeconds}s.png`;
    const screenshotPath = path.resolve(OUTPUT_DIR, screenshotFilename);

    await page.screenshot({ path: screenshotPath });

    return screenshotPath;
  } finally {
    await context.close();
  }
}

function logChromiumLaunchFailure(error) {
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
}

(async () => {
  try {
    await ensureDirectoryAvailable(EXAMPLE_DIR);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  let animationFiles;
  try {
    animationFiles = await collectAnimationFiles(EXAMPLE_DIR);
  } catch (error) {
    console.error('Unable to read animation examples:', error);
    process.exitCode = 1;
    return;
  }

  if (animationFiles.length === 0) {
    console.error('No animation HTML files found in assets/example');
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    logChromiumLaunchFailure(error);
    process.exitCode = 1;
    return;
  }

  const failures = [];

  try {
    for (const animationFile of animationFiles) {
      try {
        const screenshotPath = await captureAnimationFile(browser, animationFile);
        console.log(`Captured ${animationFile} -> ${screenshotPath}`);
      } catch (error) {
        failures.push(animationFile);
        console.error(`Failed to capture ${animationFile}:`, error);
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(
      `Encountered errors while capturing ${failures.length} animation(s): ${failures.join(', ')}`
    );
    process.exitCode = 1;
  }
})();

