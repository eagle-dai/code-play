const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

// Core capture settings. These defaults are chosen to match the reference
// screenshots documented in README.md, but each constant can be tuned for
// other animation suites without touching the rest of the workflow.
const DEFAULT_TARGET_TIME_MS = 4_000;
const TARGET_TIME_MS = DEFAULT_TARGET_TIME_MS;
const FRAME_CAPTURE_INTERVAL_MS = 100;
const INTERSTEP_REALTIME_WAIT_MS = 50;
const HTML_FILE_PATTERN = /\.html?$/i;
const ANIMATION_FILE = (() => {
  try {
    return resolveAnimationFilename(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();
const EXAMPLE_DIR = path.resolve(__dirname, '..', 'assets', 'example');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'tmp', 'output');
const VIEWPORT_DIMENSIONS = { width: 320, height: 240 };
const BROWSER_CHANNEL = (process.env.PLAYWRIGHT_BROWSER_CHANNEL || '').trim() || null;
const BROWSER_EXECUTABLE_PATH =
  (process.env.PLAYWRIGHT_CHROME_EXECUTABLE || '').trim() || null;

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

function resolveAnimationFilename(args) {
  if (args.length === 0) {
    throw new Error(
      'Expected the HTML file name as the first argument. Example: "npm run capture:animation -- animejs-virtual-time.html"'
    );
  }

  if (args.length > 1) {
    throw new Error(
      `Received unexpected extra arguments after "${args[0]}". Provide only the HTML file name to capture.`
    );
  }

  const animationFile = args[0];

  if (!HTML_FILE_PATTERN.test(animationFile)) {
    throw new Error(
      `The argument "${animationFile}" does not look like an HTML file. Provide a file ending in .html or .htm.`
    );
  }

  if (animationFile.includes('/') || animationFile.includes(path.sep)) {
    throw new Error(
      `Provide only the HTML file name, not a path. Received "${animationFile}".`
    );
  }

  return animationFile;
}

// Patches run before any page script executes. Each entry registers shims for a
// specific animation framework so that virtual-time fast forwarding matches the
// observable behavior of real-time playback.
const FRAMEWORK_PATCHES = [
  {
    name: 'anime.js lifecycle bootstrap hooks',
    // Injects shims so anime.js timelines behave correctly when virtual time is fast-forwarded.
    initScript: () => {
      const automationState = (window.__captureAutomation ||= {});

      if (automationState.animeLifecyclePatched) {
        return;
      }

      automationState.animeLifecyclePatched = true;

      const patchedInstances = new WeakSet();

      // Recursively decorates an anime.js instance and its children so bootstrap state is preserved after virtual seeks.
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
          // Ensures the first seek primes anime.js lifecycle flags before delegating to the native implementation.
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
          // Restores patched children after anime.js resets a timeline tree.
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
          // Applies the patch to any child animation added after initial construction.
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

      // Wraps the anime.js factory so every returned instance is patched before user code sees it.
      const wrapAnimeFactory = (factory) => {
        // Produces a patched anime.js instance from the original factory call.
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
            // Ensures nested timelines created via anime.timeline() inherit the bootstrap patch.
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

      // Replaces window.anime with the wrapped factory while preserving any existing descriptor characteristics.
      const installAnimeInterceptor = (initialValue) => {
        Object.defineProperty(window, 'anime', {
          configurable: true,
          enumerable: true,
          // Returns the most recent patched anime.js factory exposed to the page.
          get() {
            return automationState.animePatchedFactory;
          },
          // Replaces the anime.js factory while wrapping it to enforce the bootstrap shim.
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

// Confirms the example directory exists so captures have input files to process.
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

// Ensures the requested animation HTML file is available under the example directory.
async function ensureAnimationFileAvailable(directoryPath, animationFile) {
  const animationPath = path.resolve(directoryPath, animationFile);

  try {
    const stats = await fs.stat(animationPath);
    if (!stats.isFile()) {
      throw new Error(
        `Expected "${animationFile}" to be a file inside ${directoryPath}.`
      );
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `Unable to find "${animationFile}" in ${directoryPath}. Ensure the file exists before running the capture script.`
      );
    }

    throw error;
  }

  return animationPath;
}

// Uses the Chrome DevTools Protocol to advance the virtual clock by a specific budget.
async function advanceVirtualTime(client, budgetMs) {
  return new Promise((resolve, reject) => {
    // Resolves the promise when the DevTools budget event fires.
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

// Produces a monotonically increasing series of timestamps culminating in the target time.
function buildCaptureTimeline(targetTimeMs, intervalMs) {
  const sanitizedTarget = Math.max(0, Math.floor(targetTimeMs));

  if (!Number.isFinite(sanitizedTarget)) {
    return [0];
  }

  const timeline = [];

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    timeline.push(sanitizedTarget);
    return timeline;
  }

  const sanitizedInterval = Math.max(1, Math.floor(intervalMs));

  for (let timestamp = 0; timestamp < sanitizedTarget; timestamp += sanitizedInterval) {
    timeline.push(timestamp);
  }

  if (timeline.length === 0 || timeline[timeline.length - 1] !== sanitizedTarget) {
    timeline.push(sanitizedTarget);
  }

  return timeline;
}

// Locks requestAnimationFrame and Web Animations state to a specific timestamp before a capture.
async function synchronizeAnimationState(page, targetTimeMs) {
  await page.evaluate((targetTimeMs) => {
    const automationState = window.__captureAutomation;

    if (automationState?.setPerformanceNowOverride) {
      try {
        automationState.setPerformanceNowOverride(targetTimeMs);
      } catch (error) {
        console.warn('Failed to override performance.now()', error);
      }
    }

    const animations = document.getAnimations();
    for (const animation of animations) {
      try {
        animation.currentTime = targetTimeMs;
        animation.pause();
      } catch (error) {
        console.warn('Failed to fast-forward animation', error);
      }
    }

    if (automationState?.flushRafCallbacks) {
      try {
        automationState.flushRafCallbacks(targetTimeMs);
      } catch (error) {
        console.warn('Failed to flush requestAnimationFrame callbacks', error);
      }
    }

    if (automationState?.runRafCallbacksImmediately) {
      try {
        automationState.runRafCallbacksImmediately(targetTimeMs);
      } catch (error) {
        console.warn('Failed to invoke requestAnimationFrame callbacks directly', error);
      }
    }

    const animeFactory = window.anime;
    if (animeFactory && Array.isArray(animeFactory.running)) {
      for (const instance of animeFactory.running) {
        if (!instance || typeof instance.seek !== 'function') {
          continue;
        }

        try {
          instance.seek(targetTimeMs);
        } catch (error) {
          console.warn('Failed to seek anime.js instance to target time', error);
        }
      }
    }
  }, targetTimeMs);
}

// Adds a Playwright init script that counts requestAnimationFrame ticks for bootstrap tracking.
async function injectRafProbe(context) {
  // Sets up instrumentation before any page script runs inside the context.
  await context.addInitScript(() => {
    const automationState = (window.__captureAutomation ||= {});
    automationState.rafTickCount = 0;

    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const originalCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    const originalPerformanceNow = performance.now.bind(performance);
    automationState.originalPerformanceNow = originalPerformanceNow;
    automationState.performanceNowOrigin = performance.now();

    let firstPerformanceNow = null;
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => {
        const value = originalPerformanceNow();
        if (firstPerformanceNow === null) {
          firstPerformanceNow = value;
          automationState.firstPerformanceNow = value;
        }
        return value;
      },
    });

    const pendingCallbacks = new Map();
    const registeredCallbacks = new Set();
    automationState.disableRafScheduling = false;

    window.requestAnimationFrame = (callback) => {
      if (automationState.disableRafScheduling) {
        return 0;
      }

      registeredCallbacks.add(callback);

      let handle;
      const wrapped = (timestamp) => {
        automationState.rafTickCount += 1;
        pendingCallbacks.delete(handle);
        return callback(timestamp);
      };
      handle = originalRequestAnimationFrame((timestamp) => wrapped(timestamp));
      pendingCallbacks.set(handle, wrapped);
      return handle;
    };

    window.cancelAnimationFrame = (handle) => {
      pendingCallbacks.delete(handle);
      return originalCancelAnimationFrame(handle);
    };

    automationState.setPerformanceNowOverride = (fixedTimestamp) => {
      if (typeof fixedTimestamp === 'number') {
        const origin =
          typeof automationState.firstPerformanceNow === 'number'
            ? automationState.firstPerformanceNow
            : typeof automationState.performanceNowOrigin === 'number'
            ? automationState.performanceNowOrigin
            : 0;
        Object.defineProperty(performance, 'now', {
          configurable: true,
          value: () => origin + fixedTimestamp,
        });
      } else {
        Object.defineProperty(performance, 'now', {
          configurable: true,
          value: originalPerformanceNow,
        });
      }
    };

    automationState.flushRafCallbacks = (targetTimestamp) => {
      const iterationLimit = 1000;
      let iterations = 0;

      while (pendingCallbacks.size > 0 && iterations < iterationLimit) {
        const callbacks = Array.from(pendingCallbacks.values());
        pendingCallbacks.clear();

        for (const wrapped of callbacks) {
          try {
            wrapped(targetTimestamp);
          } catch (error) {
            console.warn('Failed to flush requestAnimationFrame callback', error);
          }
        }

        iterations += 1;
      }

      if (pendingCallbacks.size > 0) {
        console.warn(
          'Stopped flushing requestAnimationFrame callbacks after reaching the iteration cap.'
        );
      }
    };

    automationState.runRafCallbacksImmediately = (targetTimestamp) => {
      if (registeredCallbacks.size === 0) {
        return;
      }

      automationState.disableRafScheduling = true;
      pendingCallbacks.clear();

      try {
        for (const callback of Array.from(registeredCallbacks)) {
          try {
            callback.call(window, targetTimestamp);
          } catch (error) {
            console.warn('Failed to invoke requestAnimationFrame callback directly', error);
          }
        }
      } finally {
        automationState.disableRafScheduling = false;
      }
    };
  });
}

// Installs any framework-specific patches before page scripts execute.
async function injectFrameworkPatches(context) {
  for (const patch of FRAMEWORK_PATCHES) {
    try {
      await context.addInitScript(patch.initScript);
    } catch (error) {
      console.warn(`Failed to apply framework patch "${patch.name}":`, error);
    }
  }
}

// Waits for initial real-time ticks so animations can initialize before virtual time control begins.
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
      // Waits until the page has observed enough RAF ticks for the bootstrap heuristics.
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

// Opens an example file, fast-forwards its animations, and saves screenshots for each capture timestamp.
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
      initialVirtualTime: 0,
    });

    const captureTimeline = buildCaptureTimeline(
      TARGET_TIME_MS,
      FRAME_CAPTURE_INTERVAL_MS
    );
    const finalTimestamp = captureTimeline[captureTimeline.length - 1] || 0;
    const padLength = Math.max(4, String(finalTimestamp).length);

    const safeName = animationFile
      .replace(/[\\/]/g, '-')
      .replace(HTML_FILE_PATTERN, '')
      .trim();
    const screenshotBasename = safeName || 'animation';
    const screenshotPaths = [];
    let currentVirtualTime = 0;

    for (const targetTimestamp of captureTimeline) {
      const normalizedTimestamp = Math.max(0, Math.round(targetTimestamp));
      const delta = normalizedTimestamp - currentVirtualTime;

      if (delta > 0) {
        await advanceVirtualTime(client, delta);
        currentVirtualTime = normalizedTimestamp;
      }

      const settleDelay =
        normalizedTimestamp === finalTimestamp
          ? POST_VIRTUAL_TIME_WAIT_MS
          : INTERSTEP_REALTIME_WAIT_MS;

      if (settleDelay > 0) {
        await page.waitForTimeout(settleDelay);
      }

      await synchronizeAnimationState(page, normalizedTimestamp);

      const timestampLabel = String(normalizedTimestamp).padStart(
        padLength,
        '0'
      );
      const screenshotFilename = `${screenshotBasename}-${timestampLabel}ms.png`;
      const screenshotPath = path.resolve(OUTPUT_DIR, screenshotFilename);

      await page.screenshot({ path: screenshotPath });
      screenshotPaths.push(screenshotPath);
    }

    return screenshotPaths;
  } finally {
    await context.close();
  }
}

// Prints actionable troubleshooting hints when Chromium fails to start.
function logChromiumLaunchFailure(error) {
  const message = error?.message || '';

  if (message.includes("Executable doesn't exist")) {
    console.error(
      'Playwright Chromium binary not found. Run "npx playwright install chromium" and retry.'
    );
  } else if (BROWSER_EXECUTABLE_PATH) {
    console.error(
      `Unable to launch the browser at PLAYWRIGHT_CHROME_EXECUTABLE (currently '${BROWSER_EXECUTABLE_PATH}'). Verify the path and retry.`
    );
  } else if (BROWSER_CHANNEL) {
    console.error(
      `Failed to launch the Playwright channel "${BROWSER_CHANNEL}". Ensure the corresponding browser (for example Google Chrome for "chrome") is installed and Playwright supports it on this platform.`
    );
  } else if (message.includes('Host system is missing dependencies')) {
    console.error(
      'Chromium is missing required system libraries. Install them with "npx playwright install-deps" (or consult Playwright\'s documentation for your platform) and retry.'
    );
  } else {
    console.error('Failed to launch Chromium:', error);
  }
}

// Orchestrates the capture workflow end-to-end for the requested animation.
(async () => {
  try {
    await ensureDirectoryAvailable(EXAMPLE_DIR);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  try {
    await ensureAnimationFileAvailable(EXAMPLE_DIR, ANIMATION_FILE);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let browser;
  try {
    const launchOptions = {};
    if (BROWSER_EXECUTABLE_PATH) {
      launchOptions.executablePath = BROWSER_EXECUTABLE_PATH;
    } else if (BROWSER_CHANNEL) {
      launchOptions.channel = BROWSER_CHANNEL;
    }

    browser = await chromium.launch(launchOptions);
  } catch (error) {
    logChromiumLaunchFailure(error);
    process.exitCode = 1;
    return;
  }

  try {
    const screenshotPaths = await captureAnimationFile(browser, ANIMATION_FILE);

    if (screenshotPaths.length === 0) {
      console.warn(`No screenshots were generated for ${ANIMATION_FILE}.`);
    } else if (screenshotPaths.length === 1) {
      console.log(`Captured ${ANIMATION_FILE} -> ${screenshotPaths[0]}`);
    } else {
      const formatted = screenshotPaths.map((file) => `  - ${file}`).join('\n');
      console.log(`Captured ${ANIMATION_FILE} ->\n${formatted}`);
    }
  } catch (error) {
    console.error(`Failed to capture ${ANIMATION_FILE}:`, error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

