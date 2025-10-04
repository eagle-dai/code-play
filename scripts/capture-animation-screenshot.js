const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

// Core capture settings. These defaults are chosen to match the reference
// screenshots documented in README.md, but each constant can be tuned for
// other animation suites without touching the rest of the workflow.
const TARGET_TIME_MS = 4_000;
const VIRTUAL_TIME_STEP_MS = 250;
const EXAMPLE_DIR = path.resolve(__dirname, '..', 'assets', 'example');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'tmp', 'output');
const VIEWPORT_DIMENSIONS = { width: 320, height: 240 };
const MEDIA_ELEMENT_SELECTOR = 'video, audio';
const MEDIA_SETTLE_BUDGET_MS = 120;
const MEDIA_FRAME_WAIT_TIMEOUT_MS = 10_000;

// Real-time pre-roll before virtual time is enabled. Some animation frameworks
// perform asynchronous preparation that only kicks in after a few
// requestAnimationFrame ticks; the wait and RAF minimum help cover those
// bootstraps. The upper bound prevents pathological pages from stalling the
// capture forever.
const MIN_INITIAL_REALTIME_WAIT_MS = 120;
const MAX_INITIAL_REALTIME_WAIT_MS = 1_000;
const MIN_RAF_TICKS_BEFORE_VIRTUAL_TIME = 30;

// Once the target virtual timestamp is reached, give the page a final moment to
// settle so mutation observers or microtasks triggered by the last frame can
// complete before taking the screenshot.
const POST_VIRTUAL_TIME_WAIT_MS = 1_000;
const HTML_FILE_PATTERN = /\.html?$/i;

// Patches run before any page script executes. Each entry registers shims for a
// specific animation framework so that virtual-time fast forwarding matches the
// observable behavior of real-time playback.
const FRAMEWORK_PATCHES = [
  {
    name: 'anime.js lifecycle bootstrap hooks',
    initScript: () => {
      const automationState = (window.__captureAutomation ||= {});

      if (automationState.animeLifecyclePatched) {
        return;
      }

      automationState.animeLifecyclePatched = true;

      const patchedInstances = new WeakSet();

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
            let normalizedTarget;
            if (typeof time === 'number') {
              normalizedTarget = time;
            } else {
              const coerced = Number(time);
              normalizedTarget = Number.isFinite(coerced) ? coerced : NaN;
            }
            const needsBootstrap =
              Number.isFinite(normalizedTarget) &&
              normalizedTarget > 0 &&
              previousTime === 0 &&
              (!instance.began || !instance.loopBegan);

            if (needsBootstrap) {
              try {
                // Anime.js only flips `began`, `loopBegan`, and `changeBegan`
                // once a prior tick has advanced `currentTime` above zero. By
                // nudging to the smallest positive value we let the native
                // `setInstanceProgress()` path fire the complete callback
                // cascade (including `update`) while keeping the original
                // ordering intact.
                instance.currentTime = Number.MIN_VALUE;
              } catch (error) {
                console.warn('anime.js bootstrap shim failed to prime currentTime', error);
              }
            }

            try {
              return originalSeek.call(this, time);
            } catch (error) {
              if (needsBootstrap) {
                try {
                  instance.currentTime = previousTime;
                } catch (restoreError) {
                  console.warn('Failed to restore anime.js currentTime after seek error', restoreError);
                }
              }
              throw error;
            }
          };
        }

        const originalReset = typeof instance.reset === 'function' ? instance.reset : null;
        if (originalReset) {
          instance.reset = function patchedReset() {
            // Resetting an anime.js timeline reinstates child animations. Those
            // children need to be re-patched so any subsequent virtual-time
            // seeks continue to respect the bootstrap shim.
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
            // Adding child animations at runtime should immediately inherit the
            // patched seek behavior. Recurse after the native call so we only
            // touch the newly inserted nodes.
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
          // Every anime.js invocation yields a timeline/animation object. Patch
          // the returned instance before exposing it to user code so that any
          // immediate `seek()`/`pause()` calls inside page scripts benefit from
          // the bootstrap.
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
              // `anime.timeline()` constructs nested timelines without routing
              // through the main factory function. Mirror the same patch step
              // so the bootstrap logic remains consistent across APIs.
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

      // Install the interceptor immediately so any subsequent inline scripts
      // that assign to `window.anime` receive the wrapped factory.
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

async function synchronizeMediaPlayback(page, targetTimeMs) {
  if (!page || typeof targetTimeMs !== 'number' || targetTimeMs < 0) {
    return;
  }

  const syncPlan = await page.evaluate(
    ({ selector, targetTimeMs: evaluateTargetTimeMs }) => {
      const targetSeconds = Math.max(0, evaluateTargetTimeMs / 1000);
      const mediaElements = Array.from(document.querySelectorAll(selector));

      const toFinite = (value) => (Number.isFinite(value) ? value : NaN);
      const pickLatestBufferedTime = (element) => {
        if (!element?.buffered || element.buffered.length === 0) {
          return NaN;
        }

        let latest = NaN;
        for (let i = 0; i < element.buffered.length; i += 1) {
          const candidate = element.buffered.end(i);
          if (!Number.isFinite(candidate)) {
            continue;
          }

          if (!Number.isFinite(latest) || candidate > latest) {
            latest = candidate;
          }
        }

        return latest;
      };

      const epsilon = 1 / 120; // ~8ms guard against redundant seeks.
      const plan = [];

      mediaElements.forEach((element, index) => {
        if (!element) {
          return;
        }

        const initialReadyState = element.readyState;

        if (initialReadyState < element.HAVE_METADATA) {
          plan.push({ index, skipWait: true, initialReadyState });
          return;
        }

        const duration = toFinite(element.duration);
        const latestBuffered = pickLatestBufferedTime(element);
        const naturalTime = toFinite(element.currentTime);
        const naturalFrameIsReady =
          Number.isFinite(naturalTime) &&
          naturalTime >= 0 &&
          (element.paused || element.ended) &&
          element.readyState >= element.HAVE_CURRENT_DATA;

        const candidateTimes = [targetSeconds];

        if (Number.isFinite(duration) && duration >= 0) {
          candidateTimes.push(duration);
        }

        if (Number.isFinite(latestBuffered) && latestBuffered >= 0) {
          candidateTimes.push(latestBuffered);
        }

        if (naturalFrameIsReady) {
          candidateTimes.push(naturalTime);
        }

        const effectiveTarget = Math.min(...candidateTimes.filter(Number.isFinite));

        if (!Number.isFinite(effectiveTarget)) {
          plan.push({ index, skipWait: true });
          return;
        }

        try {
          element.pause?.();
        } catch (error) {
          // Ignore pause errors.
        }

        const needsSeek =
          !Number.isFinite(naturalTime) || Math.abs(naturalTime - effectiveTarget) > epsilon;

        let seekApplied = false;

        if (needsSeek) {
          try {
            element.currentTime = effectiveTarget;
            seekApplied = true;
          } catch (error) {
            plan.push({ index, skipWait: true });
            return;
          }
        }

        plan.push({
          index,
          targetSeconds: effectiveTarget,
          requiresReadyCheck: seekApplied || !naturalFrameIsReady,
          initialReadyState,
        });

        try {
          element.pause?.();
        } catch (error) {
          // Ignore pause errors.
        }
      });

      return { plan, epsilon };
    },
    {
      selector: MEDIA_ELEMENT_SELECTOR,
      targetTimeMs,
    }
  );

  const entriesToVerify =
    syncPlan?.plan?.filter((entry) => entry && entry.requiresReadyCheck && entry.targetSeconds !== undefined) || [];

  if (entriesToVerify.length === 0) {
    return;
  }

  const waitResult = await page
    .waitForFunction(
      ({ selector, entries, epsilon }) => {
        const mediaElements = Array.from(document.querySelectorAll(selector));

        return entries.every((entry) => {
          if (!entry) {
            return true;
          }

          const element = mediaElements[entry.index];
          if (!element) {
            return true;
          }

          const currentTime = Number(element.currentTime);
          if (!Number.isFinite(currentTime)) {
            return false;
          }

          const closeEnough = Math.abs(currentTime - entry.targetSeconds) <= epsilon;
          const hasFrame = element.readyState >= element.HAVE_CURRENT_DATA;

          return closeEnough && hasFrame;
        });
      },
      {
        selector: MEDIA_ELEMENT_SELECTOR,
        entries: entriesToVerify,
        epsilon: syncPlan?.epsilon || 1 / 120,
      },
      { timeout: MEDIA_FRAME_WAIT_TIMEOUT_MS }
    )
    .catch(async (error) => {
      if (error?.name === 'TimeoutError') {
        const debugSnapshot = await page.evaluate(
          ({ selector, entries }) => {
            const mediaElements = Array.from(document.querySelectorAll(selector));
            return entries.map((entry) => {
              const element = mediaElements[entry.index];

              if (!element) {
                return { index: entry.index, missing: true };
              }

              const bufferedSummary = (() => {
                if (!element.buffered || element.buffered.length === 0) {
                  return [];
                }

                const ranges = [];
                for (let i = 0; i < element.buffered.length; i += 1) {
                  ranges.push({ start: element.buffered.start(i), end: element.buffered.end(i) });
                }
                return ranges;
              })();

              return {
                index: entry.index,
                targetSeconds: entry.targetSeconds,
                currentTime: element.currentTime,
                readyState: element.readyState,
                paused: element.paused,
                ended: element.ended,
                buffered: bufferedSummary,
                error: element.error ? { code: element.error.code, message: element.error.message } : null,
              };
            });
          },
          { selector: MEDIA_ELEMENT_SELECTOR, entries: entriesToVerify }
        );

        throw new Error(
          `${error.message}\nMedia synchronization state: ${JSON.stringify(debugSnapshot)}`,
          { cause: error }
        );
      }

      throw error;
    });

  await waitResult;
}

async function ensureMediaMetadataLoaded(page) {
  if (!page) {
    return;
  }

  try {
    await page.waitForFunction(
      (selector) => {
        const mediaElements = Array.from(document.querySelectorAll(selector));

        return mediaElements.every((element) => {
          if (!element) {
            return true;
          }

          if (element.readyState >= element.HAVE_METADATA) {
            return true;
          }

          if (element.error) {
            return true;
          }

          return false;
        });
      },
      MEDIA_ELEMENT_SELECTOR,
      { timeout: MEDIA_FRAME_WAIT_TIMEOUT_MS }
    );
  } catch (error) {
    if (/Timeout/i.test(error?.message || '')) {
      console.warn('Timed out waiting for media metadata before synchronization.');
    } else {
      throw error;
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
    await ensureMediaMetadataLoaded(page);
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

    if (MEDIA_SETTLE_BUDGET_MS > 0) {
      await advanceVirtualTime(client, MEDIA_SETTLE_BUDGET_MS);
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

    await synchronizeMediaPlayback(page, TARGET_TIME_MS);

    await page.waitForTimeout(POST_VIRTUAL_TIME_WAIT_MS);

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

