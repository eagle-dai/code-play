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
const HTML_FILE_PATTERN = /\.html?$/i;

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

// Reads all HTML animation files within the example directory in sorted order.
async function collectAnimationFiles(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && HTML_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
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

// Adds a Playwright init script that counts requestAnimationFrame ticks for bootstrap tracking.
async function injectRafProbe(context) {
  // Sets up instrumentation before any page script runs inside the context.
  await context.addInitScript(() => {
    const automationState = (window.__captureAutomation ||= {});
    automationState.rafTickCount = 0;

    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);

    // Wraps requestAnimationFrame so we can count how many ticks occurred before virtual time takes over.
    window.requestAnimationFrame = (callback) =>
      originalRequestAnimationFrame((timestamp) => {
        automationState.rafTickCount += 1;
        return callback(timestamp);
      });
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

// Opens an example file, fast-forwards its animations, and saves a screenshot for the target timestamp.
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
      // Steps through every Web Animation on the page to lock them to the target timestamp.
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

// Orchestrates the capture workflow end-to-end for every example animation.
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

