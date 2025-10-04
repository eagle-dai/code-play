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
const MEDIA_READY_TIMEOUT_MS = 5_000;
const MEDIA_READY_STATE_THRESHOLD = 2; // HTMLMediaElement.HAVE_CURRENT_DATA
const MEDIA_FALLBACK_BROWSER_CHANNEL = 'chrome';

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

class UnsupportedMediaError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'UnsupportedMediaError';
    this.details = details;
  }
}

function formatBrowserChannelLabel(channel) {
  if (!channel) {
    return 'Chromium';
  }

  if (channel === 'chrome') {
    return 'Chrome';
  }

  return channel;
}

function reportCaptureFailures(failures) {
  if (!failures || failures.length === 0) {
    return;
  }

  console.error(
    `Encountered errors while capturing ${failures.length} animation(s): ${failures.join(', ')}`
  );
  process.exitCode = 1;
}

function logUnsupportedMediaDetails(details) {
  if (!Array.isArray(details) || details.length === 0) {
    return;
  }

  console.error('Unsupported media sources detected:');
  for (const entry of details) {
    const label = entry?.tagName ? `<${entry.tagName}>` : '<media>';
    const current = entry?.currentSrc ? ` ${entry.currentSrc}` : ' (no currentSrc available)';
    console.error(`  - ${label}${current}`);

    if (Array.isArray(entry?.sources) && entry.sources.length > 0) {
      for (const source of entry.sources) {
        const parts = [];
        if (source?.src) {
          parts.push(source.src);
        }
        if (source?.type) {
          parts.push(`type=${source.type}`);
        }
        console.error(`      source: ${parts.join(' ') || '(no src attribute)'}`);
      }
    }

    if (entry?.error) {
      const { code, message } = entry.error;
      console.error(`      error: code=${code} message=${message || ''}`);
    }
  }
}

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

async function waitForMediaReady(page) {
  if (MEDIA_READY_TIMEOUT_MS <= 0) {
    return;
  }

  const startTime = Date.now();

  while (Date.now() - startTime < MEDIA_READY_TIMEOUT_MS) {
    const state = await page.evaluate((readyStateThreshold) => {
      const elements = Array.from(document.querySelectorAll('video, audio'));

      if (elements.length === 0) {
        return { state: 'ready' };
      }

      const unsupported = [];
      let pending = false;

      for (const element of elements) {
        if (!element) {
          continue;
        }

        const sources = Array.from(element.querySelectorAll('source')).map((source) => ({
          src: source?.src || null,
          type: source?.type || null,
        }));

        if (element.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
          unsupported.push({
            tagName: element.tagName.toLowerCase(),
            currentSrc: element.currentSrc || null,
            sources,
          });
          continue;
        }

        if (element.error) {
          unsupported.push({
            tagName: element.tagName.toLowerCase(),
            currentSrc: element.currentSrc || null,
            error: {
              code: element.error.code,
              message: element.error.message || null,
            },
            sources,
          });
          continue;
        }

        if (typeof element.readyState !== 'number' || element.readyState < readyStateThreshold) {
          pending = true;
        }
      }

      if (unsupported.length > 0) {
        return { state: 'unsupported', details: unsupported };
      }

      if (!pending) {
        return { state: 'ready' };
      }

      return { state: 'pending' };
    }, MEDIA_READY_STATE_THRESHOLD);

    if (state.state === 'ready') {
      return;
    }

    if (state.state === 'unsupported') {
      throw new UnsupportedMediaError(
        'One or more media elements could not locate a playable source.',
        state.details
      );
    }

    await page.waitForTimeout(100);
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
    await waitForMediaReady(page);

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

async function captureAllAnimationsWithBrowser(channel, animationFiles) {
  const launchOptions = {};
  if (channel) {
    launchOptions.channel = channel;
  }

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    error.browserChannel = channel;
    throw error;
  }

  const failures = [];

  try {
    for (const animationFile of animationFiles) {
      try {
        const screenshotPath = await captureAnimationFile(browser, animationFile);
        console.log(`Captured ${animationFile} -> ${screenshotPath}`);
      } catch (error) {
        if (error instanceof UnsupportedMediaError) {
          error.browserChannel = channel;
          throw error;
        }

        failures.push(animationFile);
        console.error(`Failed to capture ${animationFile}:`, error);
      }
    }
  } finally {
    await browser.close();
  }

  return failures;
}

function logBrowserLaunchFailure(error, channel) {
  const message = error?.message || '';
  const label = formatBrowserChannelLabel(channel);
  const installCommand = channel ? `npx playwright install ${channel}` : 'npx playwright install chromium';

  if (message.includes("Executable doesn't exist")) {
    console.error(`${label} binary not found. Run "${installCommand}" and retry.`);
    return;
  }

  if (message.includes('Host system is missing dependencies')) {
    console.error(
      `${label} is missing required system libraries. Install them with "npx playwright install-deps" (or consult Playwright's documentation for your platform) and retry.`
    );
    return;
  }

  console.error(`Failed to launch ${label}:`, error);
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

  try {
    const failures = await captureAllAnimationsWithBrowser(null, animationFiles);
    reportCaptureFailures(failures);
    return;
  } catch (error) {
    if (error instanceof UnsupportedMediaError) {
      if (!MEDIA_FALLBACK_BROWSER_CHANNEL) {
        console.error(
          `${formatBrowserChannelLabel(null)} could not decode the required media sources.`
        );
        logUnsupportedMediaDetails(error.details);
        console.error(
          'Install a browser build with the necessary codecs (for example, run "npx playwright install chrome") and retry.'
        );
        process.exitCode = 1;
        return;
      }

      console.warn(
        `${formatBrowserChannelLabel(null)} could not decode the required media sources. Retrying with ${formatBrowserChannelLabel(MEDIA_FALLBACK_BROWSER_CHANNEL)}...`
      );

      try {
        const fallbackFailures = await captureAllAnimationsWithBrowser(
          MEDIA_FALLBACK_BROWSER_CHANNEL,
          animationFiles
        );
        reportCaptureFailures(fallbackFailures);
        return;
      } catch (fallbackError) {
        if (fallbackError instanceof UnsupportedMediaError) {
          console.error(
            `${formatBrowserChannelLabel(MEDIA_FALLBACK_BROWSER_CHANNEL)} also failed to decode the required media sources.`
          );
          logUnsupportedMediaDetails(fallbackError.details);
          console.error(
            'Ensure the example media files use codecs supported by your browser build and retry.'
          );
        } else if (fallbackError.browserChannel !== undefined) {
          logBrowserLaunchFailure(fallbackError, fallbackError.browserChannel);
        } else {
          console.error('Failed to capture animations:', fallbackError);
        }
        process.exitCode = 1;
        return;
      }
    }

    if (error.browserChannel !== undefined) {
      logBrowserLaunchFailure(error, error.browserChannel);
      process.exitCode = 1;
      return;
    }

    console.error('Failed to capture animations:', error);
    process.exitCode = 1;
  }
})();

