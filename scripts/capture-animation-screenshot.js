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
const HTML_FILE_PATTERN = /\.html?$/i;
const MEDIA_AUTOPLAY_TIMEOUT_MS = 2_000;
const CHROMIUM_LAUNCH_OPTIONS = {
  // Allow media elements (e.g., videos) to autoplay without a prior user gesture.
  args: ['--autoplay-policy=no-user-gesture-required'],
};

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

async function captureAnimationFile(browser, animationFile) {
  const targetPath = path.resolve(EXAMPLE_DIR, animationFile);
  const context = await browser.newContext({ viewport: VIEWPORT_DIMENSIONS });
  const page = await context.newPage();

  try {
    const fileUrl = pathToFileURL(targetPath).href;
    await page.goto(fileUrl, { waitUntil: 'load' });

    const client = await context.newCDPSession(page);

    await ensureMediaAutoplay(page, client);

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

      const targetSeconds = targetTimeMs / 1000;
      const mediaElements = document.querySelectorAll('audio, video');
      for (const media of mediaElements) {
        try {
          const rawDuration = Number(media.duration);
          const hasFiniteDuration = Number.isFinite(rawDuration) && rawDuration > 0;
          const clampedTime = hasFiniteDuration
            ? Math.min(rawDuration, targetSeconds)
            : targetSeconds;

          if (!Number.isNaN(clampedTime)) {
            media.currentTime = clampedTime;
          }

          const dispatch = (type) => {
            try {
              media.dispatchEvent(new Event(type));
            } catch (eventError) {
              console.warn(`Failed to dispatch ${type} event for media element`, eventError);
            }
          };

          if (media.paused) {
            dispatch('timeupdate');
            dispatch('pause');
          } else {
            media.pause();
          }
        } catch (error) {
          console.warn('Failed to fast-forward media element', error);
        }
      }
    }, TARGET_TIME_MS);

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

async function ensureMediaAutoplay(page, client) {
  const initialAttempt = await requestMediaPlayback(page, MEDIA_AUTOPLAY_TIMEOUT_MS);

  if (!initialAttempt.attempted || initialAttempt.blocked.length === 0) {
    return;
  }

  await synthesizeUserGesture(client);

  const retryAttempt = await requestMediaPlayback(page, MEDIA_AUTOPLAY_TIMEOUT_MS);
  if (retryAttempt.blocked.length > 0) {
    const details = retryAttempt.blocked
      .map((entry) => {
        const identifier = entry.id ? `#${entry.id}` : '';
        return `${entry.tag}${identifier}`;
      })
      .join(', ');

    console.warn(
      `Autoplay restrictions prevented playback for ${retryAttempt.blocked.length} media element(s): ${details}`
    );
  }
}

async function requestMediaPlayback(page, timeoutMs) {
  return page.evaluate(async (playbackTimeoutMs) => {
    const mediaElements = Array.from(document.querySelectorAll('audio, video'));

    const blocked = [];

    const withTimeout = (promise, limit) =>
      new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error(`play() timed out after ${limit} ms`));
        }, limit);

        Promise.resolve(promise)
          .then((value) => {
            window.clearTimeout(timer);
            resolve(value);
          })
          .catch((error) => {
            window.clearTimeout(timer);
            reject(error);
          });
      });

    for (const media of mediaElements) {
      try {
        if (media.tagName === 'VIDEO' && media.muted !== true) {
          media.muted = true;
        }

        media.autoplay = true;
        const playPromise = media.play();
        if (playPromise && typeof playPromise.then === 'function') {
          await withTimeout(playPromise, playbackTimeoutMs);
        }
      } catch (error) {
        blocked.push({
          tag: media.tagName.toLowerCase(),
          id: media.id || null,
          error: error?.message || String(error),
        });
      }
    }

    return { attempted: mediaElements.length > 0, blocked };
  }, timeoutMs);
}

async function synthesizeUserGesture(client) {
  try {
    await client.send('Page.bringToFront');

    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 0,
      y: 0,
      button: 'left',
      clickCount: 1,
    });

    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 0,
      y: 0,
      button: 'left',
      clickCount: 1,
    });
  } catch (error) {
    console.warn('Failed to synthesize user gesture for media playback', error);
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
    browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS);
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

