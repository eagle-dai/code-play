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

    await page.evaluate(() => {
      const animeGlobal = window.anime;
      if (!animeGlobal || animeGlobal.__captureIncrementalPatched) {
        return;
      }

      const trackedInstances = [];
      const seenInstances = new WeakSet();

      const registerInstance = (instance) => {
        if (!instance || typeof instance !== 'object' || seenInstances.has(instance)) {
          return;
        }

        seenInstances.add(instance);
        trackedInstances.push(instance);

        if (Array.isArray(instance.children)) {
          for (const child of instance.children) {
            registerInstance(child);
          }
        }
      };

      const registerCollection = (collection) => {
        if (!collection) {
          return;
        }

        for (const item of collection) {
          registerInstance(item);
        }
      };

      const runningInstances = animeGlobal.running;
      if (Array.isArray(runningInstances) && !runningInstances.__captureIncrementalPatched) {
        runningInstances.__captureIncrementalPatched = true;

        const originalPush = runningInstances.push;
        runningInstances.push = function (...args) {
          registerCollection(args);
          return originalPush.apply(this, args);
        };

        const originalUnshift = runningInstances.unshift;
        runningInstances.unshift = function (...args) {
          registerCollection(args);
          return originalUnshift.apply(this, args);
        };

        const originalSplice = runningInstances.splice;
        runningInstances.splice = function (start, deleteCount, ...items) {
          if (items.length > 0) {
            registerCollection(items);
          }

          const removed = originalSplice.call(this, start, deleteCount, ...items);
          registerCollection(removed);
          return removed;
        };

        const originalPop = runningInstances.pop;
        runningInstances.pop = function () {
          const removed = originalPop.call(this);
          registerCollection([removed]);
          return removed;
        };

        const originalShift = runningInstances.shift;
        runningInstances.shift = function () {
          const removed = originalShift.call(this);
          registerCollection([removed]);
          return removed;
        };
      }

      registerCollection(runningInstances);

      const originalTimeline = animeGlobal.timeline;
      if (typeof originalTimeline === 'function' && !originalTimeline.__captureIncrementalPatched) {
        const wrappedTimeline = function (...args) {
          const instance = originalTimeline.apply(this, args);
          registerInstance(instance);
          return instance;
        };

        Object.setPrototypeOf(wrappedTimeline, Object.getPrototypeOf(originalTimeline));
        wrappedTimeline.prototype = originalTimeline.prototype;
        Object.assign(wrappedTimeline, originalTimeline);
        Object.defineProperty(wrappedTimeline, '__captureIncrementalPatched', {
          value: true,
        });

        animeGlobal.timeline = wrappedTimeline;
      }

      const originalAnimeFunction = animeGlobal;
      if (typeof originalAnimeFunction === 'function' && !originalAnimeFunction.__captureIncrementalPatched) {
        const wrappedAnime = function (...args) {
          const instance = originalAnimeFunction.apply(this, args);
          registerInstance(instance);
          return instance;
        };

        Object.setPrototypeOf(wrappedAnime, Object.getPrototypeOf(originalAnimeFunction));
        wrappedAnime.prototype = originalAnimeFunction.prototype;
        Object.assign(wrappedAnime, originalAnimeFunction);
        Object.defineProperty(wrappedAnime, '__captureIncrementalPatched', {
          value: true,
        });

        window.anime = wrappedAnime;
      }

      window.__captureAnimeInstances = trackedInstances;
      window.__captureRegisterAnimeInstance = registerInstance;
      animeGlobal.__captureIncrementalPatched = true;
    });

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

    await page.evaluate((targetTimeMs) => {
      const fastForwardCssAnimations = () => {
        const animations = document.getAnimations();
        for (const animation of animations) {
          try {
            animation.currentTime = targetTimeMs;
            animation.pause();
          } catch (error) {
            console.warn('Failed to fast-forward animation', error);
          }
        }
      };

      const fastForwardAnimeInstances = () => {
        const animeGlobal = window.anime;
        if (!animeGlobal) {
          return;
        }

        const visited = new Set();

        const finalizeInstance = (instance) => {
          if (!instance || typeof instance !== 'object' || visited.has(instance)) {
            return;
          }

          visited.add(instance);

          if (typeof instance.seek === 'function') {
            try {
              instance.seek(targetTimeMs);
            } catch (error) {
              console.warn('Failed to seek anime.js instance', error);
            }
          } else if (typeof instance.tick === 'function') {
            try {
              instance.tick(targetTimeMs);
            } catch (error) {
              console.warn('Failed to tick anime.js instance', error);
            }
          }

          if (typeof instance.pause === 'function') {
            try {
              instance.pause();
            } catch (error) {
              console.warn('Failed to pause anime.js instance', error);
            }
          }

          if (
            instance.params &&
            typeof instance.params.begin === 'function' &&
            !instance.began
          ) {
            try {
              instance.params.begin.call(instance, instance);
              instance.began = true;
            } catch (error) {
              console.warn('Failed to run anime.js begin callback', error);
            }
          }

          if (Array.isArray(instance.children)) {
            for (const child of instance.children) {
              finalizeInstance(child);
            }
          }
        };

        const trackedInstances = Array.isArray(window.__captureAnimeInstances)
          ? window.__captureAnimeInstances
          : [];
        const registerInstance = window.__captureRegisterAnimeInstance;

        if (typeof registerInstance === 'function') {
          for (const instance of trackedInstances) {
            if (Array.isArray(instance?.children)) {
              for (const child of instance.children) {
                registerInstance(child);
              }
            }
          }

          if (Array.isArray(animeGlobal.running)) {
            for (const instance of animeGlobal.running) {
              if (Array.isArray(instance?.children)) {
                for (const child of instance.children) {
                  registerInstance(child);
                }
              }
            }
          }
        }

        const runningInstances = Array.isArray(animeGlobal.running)
          ? animeGlobal.running
          : [];

        for (const instance of [...trackedInstances, ...runningInstances]) {
          finalizeInstance(instance);
        }
      };

      fastForwardCssAnimations();
      fastForwardAnimeInstances();
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

