const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const TARGET_TIME_MS = 4_000;
const VIRTUAL_TIME_STEP_MS = 250;
const EXAMPLE_DIR = path.resolve(__dirname, '..', 'assets', 'example');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'tmp', 'output');
const VIEWPORT_DIMENSIONS = { width: 320, height: 240 };
const MIN_INITIAL_REALTIME_WAIT_MS = 120;
const MAX_INITIAL_REALTIME_WAIT_MS = 1_000;
const MIN_RAF_TICKS_BEFORE_VIRTUAL_TIME = 30;
const POST_VIRTUAL_TIME_WAIT_MS = 1_000;
const HTML_FILE_PATTERN = /\.html?$/i;

const FRAMEWORK_PATCHES = [
  {
    name: 'anime.js lifecycle begin hooks',
    initScript: () => {
      const automationState = (window.__captureAutomation ||= {});

      if (automationState.animeLifecyclePatched) {
        return;
      }

      automationState.animeLifecyclePatched = true;

      const patchedInstances = new WeakSet();

      const safeInvoke = (callback, instance) => {
        try {
          callback(instance);
        } catch (error) {
          console.warn('anime.js lifecycle callback failed during capture', error);
        }
      };

      const patchInstance = (instance) => {
        if (!instance || typeof instance !== 'object' || patchedInstances.has(instance)) {
          return instance;
        }

        patchedInstances.add(instance);

        if (Array.isArray(instance.children)) {
          instance.children.forEach(patchInstance);
        }

        const originalSeek = typeof instance.seek === 'function' ? instance.seek : null;
        if (originalSeek) {
          instance.seek = function patchedSeek(time) {
            const previousTime =
              typeof instance.currentTime === 'number' ? instance.currentTime : 0;
            const hadBegan = !!instance.began;
            const hadLoopBegan = !!instance.loopBegan;
            const result = originalSeek.call(this, time);
            const movedForwardFromZero = !Number.isNaN(time) && time > 0 && previousTime === 0;

            if (movedForwardFromZero) {
              if (!hadBegan && !instance.began) {
                instance.began = true;
                if (!instance.passThrough && typeof instance.begin === 'function') {
                  safeInvoke(instance.begin, instance);
                }
              }

              if (!hadLoopBegan && !instance.loopBegan) {
                instance.loopBegan = true;
                if (!instance.passThrough && typeof instance.loopBegin === 'function') {
                  safeInvoke(instance.loopBegin, instance);
                }
              }
            }

            return result;
          };
        }

        const originalReset = typeof instance.reset === 'function' ? instance.reset : null;
        if (originalReset) {
          instance.reset = function patchedReset() {
            const result = originalReset.apply(this, arguments);
            if (Array.isArray(instance.children)) {
              instance.children.forEach(patchInstance);
            }
            return result;
          };
        }

        if (typeof instance.add === 'function') {
          const originalAdd = instance.add;
          instance.add = function patchedAdd() {
            const result = originalAdd.apply(this, arguments);
            if (Array.isArray(instance.children)) {
              instance.children.forEach(patchInstance);
            }
            return result;
          };
        }

        return instance;
      };

      const wrapAnimeFactory = (factory) => {
        const wrapped = function wrappedAnime() {
          const instance = factory.apply(this, arguments);
          return patchInstance(instance);
        };

        const descriptors = Object.getOwnPropertyDescriptors(factory);
        for (const key of Object.keys(descriptors)) {
          if (key === 'length' || key === 'name' || key === 'arguments' || key === 'caller') {
            continue;
          }

          Object.defineProperty(wrapped, key, descriptors[key]);
        }

        if (typeof factory.timeline === 'function') {
          Object.defineProperty(wrapped, 'timeline', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: function timelineWrapper() {
              const instance = factory.timeline.apply(factory, arguments);
              return patchInstance(instance);
            },
          });
        }

        return wrapped;
      };

      const installAnimeInterceptor = (initialValue) => {
        Object.defineProperty(window, 'anime', {
          configurable: true,
          enumerable: true,
          get() {
            return automationState.animePatchedFactory;
          },
          set(value) {
            if (!value) {
              automationState.animePatchedFactory = value;
              return;
            }

            if (value === automationState.animePatchedFactory) {
              return;
            }

            const originalFactory = value.__captureOriginalFactory || value;
            const patchedFactory = wrapAnimeFactory(originalFactory);
            patchedFactory.__captureOriginalFactory = originalFactory;
            automationState.animePatchedFactory = patchedFactory;

            Object.defineProperty(window, 'anime', {
              configurable: true,
              enumerable: true,
              writable: true,
              value: patchedFactory,
            });
          },
        });

        if (typeof initialValue !== 'undefined') {
          window.anime = initialValue;
        }
      };

      let initialValue;
      let hasInitialValue = false;

      try {
        if (Object.prototype.hasOwnProperty.call(window, 'anime')) {
          initialValue = window.anime;
          hasInitialValue = true;
          delete window.anime;
        }
      } catch (error) {
        initialValue = undefined;
        hasInitialValue = false;
      }

      installAnimeInterceptor(hasInitialValue ? initialValue : undefined);
    },
  },
];

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

async function injectRafProbe(context) {
  await context.addInitScript(() => {
    const automationState = (window.__captureAutomation ||= {});
    automationState.rafTickCount = 0;

    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);

    window.requestAnimationFrame = (callback) =>
      originalRequestAnimationFrame((timestamp) => {
        automationState.rafTickCount += 1;
        return callback(timestamp);
      });
  });
}

async function injectFrameworkPatches(context) {
  for (const patch of FRAMEWORK_PATCHES) {
    try {
      await context.addInitScript(patch.initScript);
    } catch (error) {
      console.warn(`Failed to apply framework patch "${patch.name}":`, error);
    }
  }
}

async function waitForAnimationBootstrap(page) {
  if (MAX_INITIAL_REALTIME_WAIT_MS <= 0) {
    return;
  }

  await page.waitForTimeout(Math.max(0, MIN_INITIAL_REALTIME_WAIT_MS));

  const remainingBudget = Math.max(
    0,
    MAX_INITIAL_REALTIME_WAIT_MS - Math.max(0, MIN_INITIAL_REALTIME_WAIT_MS)
  );

  if (remainingBudget === 0 || MIN_RAF_TICKS_BEFORE_VIRTUAL_TIME <= 0) {
    return;
  }

  try {
    await page.waitForFunction(
      (minTicks) =>
        (window.__captureAutomation?.rafTickCount || 0) >= minTicks,
      MIN_RAF_TICKS_BEFORE_VIRTUAL_TIME,
      { timeout: remainingBudget }
    );
  } catch (error) {
    if (!/Timeout/i.test(error?.message || '')) {
      throw error;
    }
  }
}

async function captureAnimationFile(browser, animationFile) {
  const targetPath = path.resolve(EXAMPLE_DIR, animationFile);
  const context = await browser.newContext({ viewport: VIEWPORT_DIMENSIONS });
  const page = await context.newPage();

  try {
    await injectRafProbe(context);
    await injectFrameworkPatches(context);
    const fileUrl = pathToFileURL(targetPath).href;
    await page.goto(fileUrl, { waitUntil: 'load' });

    // Allow a slice of real time so requestAnimationFrame callbacks (and any
    // animation framework lifecycle hooks) can run before we seize control of
    // virtual time. The RAF probe waits for a minimum number of ticks—up to a
    // 1s cap—to cover animations that rely on several frames of bootstrap work
    // before reaching their steady state.
    await waitForAnimationBootstrap(page);

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

