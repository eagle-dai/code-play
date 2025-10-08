const fs = require("fs/promises");
const path = require("path");
const { pathToFileURL } = require("url");

// Core capture settings. These defaults are chosen to match the reference
// screenshots documented in README.md, but each constant can be tuned for
// other animation suites without touching the rest of the workflow.
const DEFAULT_TARGET_TIME_MS = 4_000;
const HTML_FILE_PATTERN = /\.html?$/i;

const DEFAULT_CAPTURE_CONFIG = Object.freeze({
  targetTimeMs: DEFAULT_TARGET_TIME_MS,
  frameCaptureIntervalMs: 200,
  interstepRealtimeWaitMs: 50,
  // Real-time pre-roll before virtual time is enabled. Some animation frameworks only stabilize
  // after several requestAnimationFrame ticks, so we give them a configurable window.
  minInitialRealtimeWaitMs: 120,
  maxInitialRealtimeWaitMs: 1_000,
  minRafTicksBeforeVirtualTime: 30,
  // Once the target virtual timestamp is reached, give the page a final moment to settle before taking screenshots.
  postVirtualTimeWaitMs: 1_000,
  exampleDir: path.resolve(__dirname, "..", "assets", "example"),
  outputDir: path.resolve(__dirname, "..", "tmp", "output"),
  viewport: Object.freeze({ width: 320, height: 240 }),
});

// Builds an immutable configuration object for the capture workflow based on CLI args and environment variables.
function buildCaptureConfig(argv, env = process.env) {
  const animationPattern = resolveAnimationPattern(argv);
  const browserChannel = (env.PLAYWRIGHT_BROWSER_CHANNEL || "").trim();
  const browserExecutablePath = (env.PLAYWRIGHT_CHROME_EXECUTABLE || "").trim();

  return Object.freeze({
    animationPattern,
    browserChannel: browserChannel || null,
    browserExecutablePath: browserExecutablePath || null,
    targetTimeMs: DEFAULT_CAPTURE_CONFIG.targetTimeMs,
    frameCaptureIntervalMs: DEFAULT_CAPTURE_CONFIG.frameCaptureIntervalMs,
    interstepRealtimeWaitMs: DEFAULT_CAPTURE_CONFIG.interstepRealtimeWaitMs,
    postVirtualTimeWaitMs: DEFAULT_CAPTURE_CONFIG.postVirtualTimeWaitMs,
    minInitialRealtimeWaitMs: DEFAULT_CAPTURE_CONFIG.minInitialRealtimeWaitMs,
    maxInitialRealtimeWaitMs: DEFAULT_CAPTURE_CONFIG.maxInitialRealtimeWaitMs,
    minRafTicksBeforeVirtualTime:
      DEFAULT_CAPTURE_CONFIG.minRafTicksBeforeVirtualTime,
    exampleDir: DEFAULT_CAPTURE_CONFIG.exampleDir,
    outputDir: DEFAULT_CAPTURE_CONFIG.outputDir,
    viewport: { ...DEFAULT_CAPTURE_CONFIG.viewport },
  });
}

function assertFiniteNumber(value, propertyName) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `Expected ${propertyName} to be a finite number. Received ${value}.`
    );
  }
}

function validateCaptureConfig(config) {
  assertFiniteNumber(
    config.minInitialRealtimeWaitMs,
    "config.minInitialRealtimeWaitMs"
  );
  assertFiniteNumber(
    config.maxInitialRealtimeWaitMs,
    "config.maxInitialRealtimeWaitMs"
  );

  if (config.minInitialRealtimeWaitMs <= 0) {
    throw new Error(
      `Expected config.minInitialRealtimeWaitMs to be greater than 0. Received ${config.minInitialRealtimeWaitMs}.`
    );
  }

  if (config.maxInitialRealtimeWaitMs <= 0) {
    throw new Error(
      `Expected config.maxInitialRealtimeWaitMs to be greater than 0. Received ${config.maxInitialRealtimeWaitMs}.`
    );
  }

  if (config.maxInitialRealtimeWaitMs < config.minInitialRealtimeWaitMs) {
    throw new Error(
      `Expected config.maxInitialRealtimeWaitMs (${config.maxInitialRealtimeWaitMs}) to be greater than or equal to config.minInitialRealtimeWaitMs (${config.minInitialRealtimeWaitMs}).`
    );
  }
}

function resolveAnimationPattern(args) {
  if (args.length === 0) {
    throw new Error(
      'Expected the HTML file name as the first argument. Example: "npm run capture:animation -- animejs-virtual-time.html"'
    );
  }

  if (args.length > 1) {
    throw new Error(
      `Received unexpected extra arguments after "${args[0]}". Provide only the HTML file name or pattern to capture.`
    );
  }

  const animationPattern = args[0];

  if (animationPattern.includes("/") || animationPattern.includes(path.sep)) {
    throw new Error(
      `Provide only the HTML file name, not a path. Received "${animationPattern}".`
    );
  }

  const validationSample = animationPattern.replace(/[\*\?]/g, "a");
  if (!HTML_FILE_PATTERN.test(validationSample)) {
    throw new Error(
      `The argument "${animationPattern}" does not look like an HTML file. Provide a file ending in .html or .htm.`
    );
  }

  return animationPattern;
}

function containsWildcards(pattern) {
  return /[\*\?]/.test(pattern);
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const translated = escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${translated}$`, "i");
}

// Creates browser launch options derived from the resolved configuration.
function buildBrowserLaunchOptions(config) {
  const launchOptions = {};

  if (config.browserExecutablePath) {
    launchOptions.executablePath = config.browserExecutablePath;
  } else if (config.browserChannel) {
    launchOptions.channel = config.browserChannel;
  }

  return launchOptions;
}

function loadChromium() {
  try {
    const playwright = require("playwright");

    if (!playwright?.chromium) {
      throw new Error(
        'Playwright is installed but does not expose a "chromium" browser type. Ensure the Playwright package is up to date.'
      );
    }

    return playwright.chromium;
  } catch (error) {
    if (
      error?.code === "MODULE_NOT_FOUND" &&
      typeof error.message === "string" &&
      error.message.includes("'playwright'")
    ) {
      throw new Error(
        'Playwright is not installed. Run "npm install" before using the capture script.',
        { cause: error }
      );
    }

    throw error;
  }
}

// Patches run before any page script executes. Each entry registers shims for a
// specific animation framework so that virtual-time fast-forwarding matches the
// observable behavior of real-time playback.
const FRAMEWORK_PATCHES = [
  {
    name: "anime.js lifecycle bootstrap hooks",
    // Injects shims so anime.js timelines behave correctly when virtual time is fast-forwarded.
    initScript: () => {
      const automationState = (window.__captureAutomation ||= {});

      if (automationState.animeLifecyclePatched) {
        return;
      }

      automationState.animeLifecyclePatched = true;

      const patchedInstances = new WeakSet();
      const trackedInstances = (automationState.animeTrackedInstances ||=
        new Set());

      automationState.getTrackedAnimeInstances = () =>
        Array.from(trackedInstances).filter(
          (instance) => instance && typeof instance === "object"
        );

      // Recursively decorates an anime.js instance and its children so bootstrap state is preserved after virtual seeks.
      const patchInstance = (instance) => {
        if (
          !instance ||
          typeof instance !== "object" ||
          patchedInstances.has(instance)
        ) {
          return instance;
        }

        patchedInstances.add(instance);
        trackedInstances.add(instance);

        if (Array.isArray(instance.children)) {
          instance.children.forEach(patchInstance);
        }

        const originalSeek =
          typeof instance.seek === "function" ? instance.seek : null;
        if (originalSeek) {
          // Ensures the first seek primes anime.js lifecycle flags before delegating to the native implementation.
          instance.seek = function patchedSeek(time) {
            const previousTime =
              typeof instance.currentTime === "number"
                ? instance.currentTime
                : 0;
            let normalizedTarget;
            if (typeof time === "number") {
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
                console.warn(
                  "anime.js bootstrap shim failed to prime currentTime",
                  error
                );
              }
            }

            try {
              return originalSeek.call(this, time);
            } catch (error) {
              if (needsBootstrap) {
                try {
                  instance.currentTime = previousTime;
                } catch (restoreError) {
                  console.warn(
                    "Failed to restore anime.js currentTime after seek error",
                    restoreError
                  );
                }
              }
              throw error;
            }
          };
        }

        const originalReset =
          typeof instance.reset === "function" ? instance.reset : null;
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

        if (typeof instance.add === "function") {
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
        const copyDescriptorsOnto = (target, source) => {
          const descriptors = Object.getOwnPropertyDescriptors(source);
          for (const key of Reflect.ownKeys(descriptors)) {
            if (
              key === "length" ||
              key === "name" ||
              key === "arguments" ||
              key === "caller"
            ) {
              continue;
            }

            Object.defineProperty(target, key, descriptors[key]);
          }
        };

        const patchMethod = (target, source, methodName) => {
          const originalMethod = source?.[methodName];
          if (typeof originalMethod !== "function") {
            return;
          }

          Object.defineProperty(target, methodName, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: function patchedMethod() {
              const instance = originalMethod.apply(source, arguments);
              return patchInstance(instance);
            },
          });
        };

        if (typeof factory !== "function") {
          const wrapMethodNames = new Set(["createTimeline", "timeline", "animate"]);
          const wrappedMethods = new Map();

          return new Proxy(factory, {
            get(target, property, receiver) {
              if (property === "__captureOriginalFactory") {
                return target;
              }

              const value = Reflect.get(target, property, receiver);

              if (
                typeof property === "string" &&
                wrapMethodNames.has(property) &&
                typeof value === "function"
              ) {
                if (wrappedMethods.has(property)) {
                  return wrappedMethods.get(property);
                }

                const wrappedMethod = function patchedMethod() {
                  const instance = value.apply(target, arguments);
                  return patchInstance(instance);
                };

                wrappedMethods.set(property, wrappedMethod);
                return wrappedMethod;
              }

              return value;
            },
            set(target, property, value, receiver) {
              if (property === "__captureOriginalFactory") {
                return true;
              }

              return Reflect.set(target, property, value, receiver);
            },
            has(target, property) {
              if (property === "__captureOriginalFactory") {
                return true;
              }

              return Reflect.has(target, property);
            },
            ownKeys(target) {
              const keys = Reflect.ownKeys(target);
              if (!keys.includes("__captureOriginalFactory")) {
                keys.push("__captureOriginalFactory");
              }
              return keys;
            },
            getOwnPropertyDescriptor(target, property) {
              if (property === "__captureOriginalFactory") {
                return {
                  configurable: true,
                  enumerable: false,
                  writable: true,
                  value: target,
                };
              }

              return Object.getOwnPropertyDescriptor(target, property);
            },
          });
        }

        // Produces a patched anime.js instance from the original factory call.
        const wrapped = function wrappedAnime() {
          // Every anime.js invocation yields a timeline/animation object. Patch
          // the returned instance before exposing it to user code so that any
          // immediate `seek()`/`pause()` calls inside page scripts benefit from
          // the bootstrap.
          const instance = factory.apply(this, arguments);
          return patchInstance(instance);
        };

        copyDescriptorsOnto(wrapped, factory);

        patchMethod(wrapped, factory, "timeline");
        patchMethod(wrapped, factory, "createTimeline");
        patchMethod(wrapped, factory, "animate");

        return wrapped;
      };

      // Replaces window.anime with the wrapped factory while preserving any existing descriptor characteristics.
      const installAnimeInterceptor = (initialValue) => {
        Object.defineProperty(window, "anime", {
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

            Object.defineProperty(window, "anime", {
              configurable: true,
              enumerable: true,
              writable: true,
              value: patchedFactory,
            });
          },
        });

        if (typeof initialValue !== "undefined") {
          window.anime = initialValue;
        }
      };

      let initialValue;
      let hasInitialValue = false;

      try {
        if (Object.prototype.hasOwnProperty.call(window, "anime")) {
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
    if (error?.code === "ENOENT") {
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
    if (error?.code === "ENOENT") {
      throw new Error(
        `Unable to find "${animationFile}" in ${directoryPath}. Ensure the file exists before running the capture script.`
      );
    }

    throw error;
  }

  return animationPath;
}

async function resolveAnimationFiles(directoryPath, animationPattern) {
  if (!containsWildcards(animationPattern)) {
    await ensureAnimationFileAvailable(directoryPath, animationPattern);
    return [animationPattern];
  }

  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Expected directory "${directoryPath}" to exist. Add animation examples under assets/example/.`
      );
    }

    throw error;
  }

  const matcher = wildcardToRegExp(animationPattern);
  const matches = [];

  for (const entry of entries) {
    if (!(entry.isFile?.() || entry.isSymbolicLink?.())) {
      continue;
    }

    const candidate = entry.name;
    if (!HTML_FILE_PATTERN.test(candidate)) {
      continue;
    }

    if (matcher.test(candidate)) {
      matches.push(candidate);
    }
  }

  matches.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );

  if (matches.length === 0) {
    throw new Error(
      `No files matched pattern "${animationPattern}" in ${directoryPath}. Adjust the pattern and retry.`
    );
  }

  return matches;
}

// Uses the Chrome DevTools Protocol to advance the virtual clock by a specific budget.
async function advanceVirtualTime(client, budgetMs) {
  return new Promise((resolve, reject) => {
    // Resolves the promise when the DevTools budget event fires.
    const handleBudgetExpired = () => resolve();

    client.once("Emulation.virtualTimeBudgetExpired", handleBudgetExpired);

    client
      .send("Emulation.setVirtualTimePolicy", {
        policy: "pauseIfNetworkFetchesPending",
        budget: budgetMs,
      })
      .catch((error) => {
        client.off("Emulation.virtualTimeBudgetExpired", handleBudgetExpired);
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

  for (
    let timestamp = 0;
    timestamp < sanitizedTarget;
    timestamp += sanitizedInterval
  ) {
    timeline.push(timestamp);
  }

  if (
    timeline.length === 0 ||
    timeline[timeline.length - 1] !== sanitizedTarget
  ) {
    timeline.push(sanitizedTarget);
  }

  return timeline;
}

// Locks requestAnimationFrame and Web Animations state to a specific timestamp before a capture.
async function synchronizeAnimationState(page, targetTimeMs) {
  await page.evaluate((targetTimeMs) => {
    const automationState = window.__captureAutomation;
    let rafTimestamp = targetTimeMs;
    let restorePerformanceNow;

    if (automationState?.setPerformanceNowOverride) {
      try {
        const overrideValue =
          automationState.setPerformanceNowOverride(targetTimeMs);
        if (Number.isFinite(overrideValue)) {
          rafTimestamp = overrideValue;
        }
        restorePerformanceNow = () => {
          try {
            automationState.setPerformanceNowOverride();
          } catch (error) {
            console.warn("Failed to restore performance.now()", error);
          }
        };
      } catch (error) {
        console.warn("Failed to override performance.now()", error);
      }
    }

    const animations = document.getAnimations();
    for (const animation of animations) {
      try {
        animation.currentTime = targetTimeMs;
        animation.pause();
      } catch (error) {
        console.warn("Failed to fast-forward animation", error);
      }
    }

    if (automationState?.flushRafCallbacks) {
      try {
        automationState.flushRafCallbacks(rafTimestamp);
      } catch (error) {
        console.warn("Failed to flush requestAnimationFrame callbacks", error);
      }
    }

    if (automationState?.runRafCallbacksImmediately) {
      try {
        automationState.runRafCallbacksImmediately(rafTimestamp);
      } catch (error) {
        console.warn(
          "Failed to invoke requestAnimationFrame callbacks directly",
          error
        );
      }
    }

    const trackedInstances = (
      automationState?.getTrackedAnimeInstances?.() || []
    ).concat(Array.isArray(window.anime?.running) ? window.anime.running : []);

    const seen = new Set();

    for (const instance of trackedInstances) {
      if (
        !instance ||
        typeof instance.seek !== "function" ||
        seen.has(instance)
      ) {
        continue;
      }

      seen.add(instance);

      try {
        instance.seek(targetTimeMs);
      } catch (error) {
        console.warn("Failed to seek anime.js instance to target time", error);
      }
    }

    if (typeof restorePerformanceNow === "function") {
      restorePerformanceNow();
    }
  }, targetTimeMs);
}

// Restores performance.now() to its native implementation so upcoming virtual time
// advances reflect the browser-provided timestamp rather than a fixed override.
async function restorePerformanceNow(page) {
  await page.evaluate(() => {
    const overrideSetter =
      window.__captureAutomation?.setPerformanceNowOverride;

    if (typeof overrideSetter !== "function") {
      return;
    }

    try {
      overrideSetter();
    } catch (error) {
      console.warn("Failed to restore performance.now()", error);
    }
  });
}

// Adds a Playwright init script that counts requestAnimationFrame ticks for bootstrap tracking.
async function injectRafProbe(context) {
  // Sets up instrumentation before any page script runs inside the context.
  await context.addInitScript(() => {
    const automationState = (window.__captureAutomation ||= {});
    automationState.rafTickCount = 0;

    const originalRequestAnimationFrame =
      window.requestAnimationFrame.bind(window);
    const originalCancelAnimationFrame =
      window.cancelAnimationFrame.bind(window);
    const originalPerformanceNow = performance.now.bind(performance);
    automationState.originalPerformanceNow = originalPerformanceNow;
    automationState.performanceNowOrigin = performance.now();

    let firstPerformanceNow = null;
    Object.defineProperty(performance, "now", {
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
    const registeredCallbacks = new Map();
    automationState.disableRafScheduling = false;

    window.requestAnimationFrame = (callback) => {
      if (automationState.disableRafScheduling) {
        return 0;
      }

      let handle;
      const wrapped = (timestamp) => {
        automationState.rafTickCount += 1;
        pendingCallbacks.delete(handle);
        registeredCallbacks.delete(handle);
        return callback(timestamp);
      };
      handle = originalRequestAnimationFrame((timestamp) => wrapped(timestamp));
      pendingCallbacks.set(handle, { callback, wrapped });
      registeredCallbacks.set(handle, callback);
      return handle;
    };

    window.cancelAnimationFrame = (handle) => {
      pendingCallbacks.delete(handle);
      registeredCallbacks.delete(handle);
      return originalCancelAnimationFrame(handle);
    };

    automationState.setPerformanceNowOverride = (fixedTimestamp) => {
      if (typeof fixedTimestamp === "number") {
        const origin =
          typeof automationState.firstPerformanceNow === "number"
            ? automationState.firstPerformanceNow
            : typeof automationState.performanceNowOrigin === "number"
              ? automationState.performanceNowOrigin
              : 0;
        const overrideValue = origin + fixedTimestamp;
        Object.defineProperty(performance, "now", {
          configurable: true,
          value: () => overrideValue,
        });
        return overrideValue;
      }

      Object.defineProperty(performance, "now", {
        configurable: true,
        value: originalPerformanceNow,
      });
      return null;
    };

    automationState.flushRafCallbacks = (targetTimestamp) => {
      if (pendingCallbacks.size === 0) {
        return;
      }

      const callbacks = Array.from(pendingCallbacks.entries());
      pendingCallbacks.clear();

      for (const [handle, { wrapped }] of callbacks) {
        try {
          wrapped(targetTimestamp);
        } catch (error) {
          console.warn("Failed to flush requestAnimationFrame callback", error);
        }

        registeredCallbacks.delete(handle);
      }
    };

    automationState.runRafCallbacksImmediately = (targetTimestamp) => {
      if (registeredCallbacks.size === 0) {
        return;
      }

      const callbacks = Array.from(registeredCallbacks.entries());

      for (const [handle, callback] of callbacks) {
        try {
          registeredCallbacks.delete(handle);
          pendingCallbacks.delete(handle);
          callback.call(window, targetTimestamp);
        } catch (error) {
          console.warn(
            "Failed to invoke requestAnimationFrame callback directly",
            error
          );
        }
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
async function waitForAnimationBootstrap(page, config) {
  if (config.maxInitialRealtimeWaitMs <= 0) {
    return;
  }

  const initialWait = Math.min(
    config.minInitialRealtimeWaitMs,
    config.maxInitialRealtimeWaitMs
  );

  if (initialWait > 0) {
    await page.waitForTimeout(initialWait);
  }

  const remainingBudget = Math.max(
    0,
    config.maxInitialRealtimeWaitMs - initialWait
  );

  if (remainingBudget === 0 || config.minRafTicksBeforeVirtualTime <= 0) {
    return;
  }

  try {
    await page.waitForFunction(
      // Waits until the page has observed enough RAF ticks for the bootstrap heuristics.
      (minTicks) => (window.__captureAutomation?.rafTickCount || 0) >= minTicks,
      config.minRafTicksBeforeVirtualTime,
      { timeout: remainingBudget }
    );
  } catch (error) {
    if (!/Timeout/i.test(error?.message || "")) {
      throw error;
    }
  }
}

// Opens an example file, fast-forwards its animations, and saves screenshots for each capture timestamp.
async function captureAnimationFile(browser, animationFile, config) {
  const targetPath = path.resolve(config.exampleDir, animationFile);
  const context = await browser.newContext({ viewport: config.viewport });
  let page;

  try {
    await injectRafProbe(context);
    await injectFrameworkPatches(context);
    page = await context.newPage();
    const fileUrl = pathToFileURL(targetPath).href;
    await page.goto(fileUrl, { waitUntil: "load" });

    // Allow a slice of real time so requestAnimationFrame callbacks (and any
    // animation framework lifecycle hooks) can run before we seize control of
    // virtual time. The RAF probe waits for a minimum number of ticks—up to a
    // 1s cap—to cover animations that rely on several frames of bootstrap work
    // before reaching their steady state.
    await waitForAnimationBootstrap(page, config);

    const client = await context.newCDPSession(page);

    await client.send("Emulation.setVirtualTimePolicy", {
      policy: "pauseIfNetworkFetchesPending",
      budget: 0,
      initialVirtualTime: 0,
    });

    const captureTimeline = buildCaptureTimeline(
      config.targetTimeMs,
      config.frameCaptureIntervalMs
    );
    const finalTimestamp = captureTimeline[captureTimeline.length - 1] || 0;
    const padLength = Math.max(4, String(finalTimestamp).length);

    const safeName = animationFile
      .replace(/[\\/]/g, "-")
      .replace(HTML_FILE_PATTERN, "")
      .trim();
    const screenshotBasename = safeName || "animation";
    const screenshotPaths = [];
    let currentVirtualTime = 0;

    for (const targetTimestamp of captureTimeline) {
      const normalizedTimestamp = Math.max(0, Math.round(targetTimestamp));
      const delta = normalizedTimestamp - currentVirtualTime;

      if (delta > 0) {
        await restorePerformanceNow(page);
        await advanceVirtualTime(client, delta);
        currentVirtualTime = normalizedTimestamp;
      }

      const settleDelay =
        normalizedTimestamp === finalTimestamp
          ? config.postVirtualTimeWaitMs
          : config.interstepRealtimeWaitMs;

      if (settleDelay > 0) {
        await page.waitForTimeout(settleDelay);
      }

      await synchronizeAnimationState(page, normalizedTimestamp);

      const timestampLabel = String(normalizedTimestamp).padStart(
        padLength,
        "0"
      );
      const screenshotFilename = `${screenshotBasename}-${timestampLabel}ms.png`;
      const screenshotPath = path.resolve(config.outputDir, screenshotFilename);

      await page.screenshot({ path: screenshotPath });
      screenshotPaths.push(screenshotPath);
    }

    await restorePerformanceNow(page);

    return screenshotPaths;
  } finally {
    await context.close();
  }
}

// Prints actionable troubleshooting hints when Chromium fails to start.
function logChromiumLaunchFailure(error, config) {
  const message = error?.message || "";

  if (message.includes("Executable doesn't exist")) {
    console.error(
      'Playwright Chromium binary not found. Run "npx playwright install chromium" and retry.'
    );
  } else if (config.browserExecutablePath) {
    console.error(
      `Unable to launch the browser at PLAYWRIGHT_CHROME_EXECUTABLE (currently '${config.browserExecutablePath}'). Verify the path and retry.`
    );
  } else if (config.browserChannel) {
    console.error(
      `Failed to launch the Playwright channel "${config.browserChannel}". Ensure the corresponding browser (for example Google Chrome for "chrome") is installed and Playwright supports it on this platform.`
    );
  } else if (message.includes("Host system is missing dependencies")) {
    console.error(
      'Chromium is missing required system libraries. Install them with "npx playwright install-deps" (or consult Playwright\'s documentation for your platform) and retry.'
    );
  } else {
    console.error("Failed to launch Chromium:", error);
  }
}

// Orchestrates the capture workflow end-to-end for the requested animation.
async function runCaptureWorkflow() {
  let config;

  try {
    config = buildCaptureConfig(process.argv.slice(2));
    validateCaptureConfig(config);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  try {
    await ensureDirectoryAvailable(config.exampleDir);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  let animationFiles;
  try {
    animationFiles = await resolveAnimationFiles(
      config.exampleDir,
      config.animationPattern
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(config.outputDir, { recursive: true });

  let chromium;
  try {
    chromium = loadChromium();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  let browser;
  try {
    browser = await chromium.launch(buildBrowserLaunchOptions(config));
  } catch (error) {
    logChromiumLaunchFailure(error, config);
    process.exitCode = 1;
    return;
  }

  try {
    let hasFailures = false;

    for (const animationFile of animationFiles) {
      try {
        const screenshotPaths = await captureAnimationFile(
          browser,
          animationFile,
          config
        );

        if (screenshotPaths.length === 0) {
          console.warn(`No screenshots were generated for ${animationFile}.`);
        } else if (screenshotPaths.length === 1) {
          console.log(`Captured ${animationFile} -> ${screenshotPaths[0]}`);
        } else {
          const formatted = screenshotPaths
            .map((file) => `  - ${file}`)
            .join("\n");
          console.log(`Captured ${animationFile} ->\n${formatted}`);
        }
      } catch (error) {
        console.error(`Failed to capture ${animationFile}:`, error);
        hasFailures = true;
      }
    }

    if (hasFailures) {
      process.exitCode = 1;
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

if (require.main === module) {
  (async () => {
    try {
      await runCaptureWorkflow();
    } catch (error) {
      console.error("Unexpected failure during capture workflow:", error);
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  buildCaptureConfig,
  buildCaptureTimeline,
  containsWildcards,
  validateCaptureConfig,
  resolveAnimationPattern,
  wildcardToRegExp,
};
