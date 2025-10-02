const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const TARGET_TIME_MS = 4_000;
const EXAMPLE_DIR = path.resolve(__dirname, '..', 'assets', 'example');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'tmp', 'output');
const VIEWPORT_DIMENSIONS = { width: 320, height: 240 };
const POST_VIRTUAL_TIME_WAIT_MS = 1_000;
const SCREENSHOT_MANIFEST_FILENAME = 'manifest.json';

(async () => {
  const entries = await fs.readdir(EXAMPLE_DIR, { withFileTypes: true });
  const animationFiles = entries
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (animationFiles.length === 0) {
    console.error('No animation HTML files found in assets/example');
    process.exit(1);
  }

  let browser;

  const generatedScreenshots = [];

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
      const targetPath = path.resolve(EXAMPLE_DIR, animationFile);

      try {
        await fs.access(targetPath);
      } catch (error) {
        console.warn(`Skipping missing animation file at ${targetPath}`);
        continue;
      }

      const safeName = animationFile
        .replace(/[\\/]/g, '-')
        .replace(/\.html?$/i, '')
        .trim();
      const targetSeconds = Math.round(TARGET_TIME_MS / 1000);
      const screenshotFilename = `${safeName || 'animation'}-${targetSeconds}s.png`;
      const screenshotPath = path.resolve(OUTPUT_DIR, screenshotFilename);

      console.log(
        `Capturing ${animationFile} at ${TARGET_TIME_MS}ms into ${path.relative(
          process.cwd(),
          screenshotPath
        )}`
      );

      const context = await browser.newContext({
        viewport: VIEWPORT_DIMENSIONS,
      });
      const page = await context.newPage();

      let captureSucceeded = false;

      try {
        const fileUrl = pathToFileURL(targetPath).href;
        await page.goto(fileUrl, { waitUntil: 'load' });

        const client = await context.newCDPSession(page);

        await client.send('Emulation.setVirtualTimePolicy', {
          policy: 'pauseIfNetworkFetchesPending',
          budget: 0,
        });

        await client.send('Emulation.setVirtualTimePolicy', {
          policy: 'advance',
          budget: TARGET_TIME_MS,
          maxVirtualTimeTaskStarvationCount: 1000,
        });

        await page.waitForTimeout(POST_VIRTUAL_TIME_WAIT_MS);

        await client.send('Animation.enable').catch(() => {});

        await page.evaluate((targetTimeMs) => {
          const initialPerformanceNow =
            typeof performance !== 'undefined' && typeof performance.now === 'function'
              ? performance.now()
              : null;
          const initialDateNow = typeof Date !== 'undefined' && typeof Date.now === 'function' ? Date.now() : null;
          const epochBase =
            initialDateNow !== null && initialPerformanceNow !== null
              ? initialDateNow - initialPerformanceNow
              : initialDateNow;

          const safelyOverride = (host, key, override) => {
            if (!host) {
              return;
            }

            const descriptor = Object.getOwnPropertyDescriptor(host, key);
            if (!descriptor || !descriptor.configurable) {
              return;
            }

            try {
              Object.defineProperty(host, key, {
                ...descriptor,
                value: override,
              });
            } catch (error) {
              console.warn(`Failed to override ${key}`, error);
            }
          };

          const freezeClocks = () => {
            if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
              safelyOverride(performance, 'now', () => targetTimeMs);
            }

            const OriginalDate = Date;

            const computeNow = () => {
              if (epochBase !== null && typeof epochBase === 'number' && Number.isFinite(epochBase)) {
                return epochBase + targetTimeMs;
              }

              if (initialDateNow !== null) {
                return initialDateNow;
              }

              return targetTimeMs;
            };

            const FrozenDate = function FrozenDate(...args) {
              if (!(this instanceof FrozenDate)) {
                return OriginalDate.apply(this, args.length ? args : [computeNow()]);
              }

              const params = args.length ? args : [computeNow()];
              return new OriginalDate(...params);
            };

            FrozenDate.prototype = OriginalDate.prototype;

            for (const key of Object.getOwnPropertyNames(OriginalDate)) {
              if (key === 'arguments' || key === 'caller') {
                continue;
              }

              const descriptor = Object.getOwnPropertyDescriptor(OriginalDate, key);
              if (descriptor && !Object.prototype.hasOwnProperty.call(FrozenDate, key)) {
                Object.defineProperty(FrozenDate, key, descriptor);
              }
            }

            FrozenDate.now = computeNow;

            safelyOverride(window, 'Date', FrozenDate);
          };

          const cancelPendingAnimationFrames = () => {
            if (typeof window === 'undefined') {
              return;
            }

            if (typeof window.requestAnimationFrame !== 'function' || typeof window.cancelAnimationFrame !== 'function') {
              return;
            }

            let lastHandle = 0;
            try {
              lastHandle = window.requestAnimationFrame(() => {});
            } catch (error) {
              console.warn('Failed to schedule rAF placeholder', error);
            }

            for (let handle = 0; handle <= lastHandle; handle += 1) {
              try {
                window.cancelAnimationFrame(handle);
              } catch (error) {
                console.warn('Failed to cancel animation frame', error);
              }
            }

            safelyOverride(window, 'requestAnimationFrame', () => lastHandle);
            safelyOverride(window, 'cancelAnimationFrame', () => {});
          };

          const synchronizeWebAnimations = () => {
            if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') {
              return;
            }

            for (const animation of document.getAnimations()) {
              try {
                if (typeof animation.finish === 'function' && animation.playState === 'idle') {
                  animation.finish();
                }

                if (typeof animation.currentTime !== 'undefined') {
                  animation.currentTime = targetTimeMs;
                }

                if (typeof animation.updatePlaybackRate === 'function') {
                  animation.updatePlaybackRate(0);
                }

                if (typeof animation.pause === 'function') {
                  animation.pause();
                }
              } catch (error) {
                console.warn('Failed to freeze Web Animation', error);
              }
            }
          };

          try {
            freezeClocks();
            cancelPendingAnimationFrames();
            synchronizeWebAnimations();
          } catch (error) {
            console.warn('Failed to synchronize animation state', error);
          }
          }, TARGET_TIME_MS);

        await client.send('Animation.setPlaybackRate', { playbackRate: 0 }).catch(() => {});

        await fs.mkdir(OUTPUT_DIR, { recursive: true });

        await page.screenshot({
          path: screenshotPath,
        });

        try {
          const stats = await fs.stat(screenshotPath);
          if (stats.size > 0) {
            captureSucceeded = true;
          } else {
            console.warn(`Screenshot at ${screenshotPath} is empty (0 bytes).`);
          }
        } catch (statError) {
          console.warn(`Unable to verify screenshot at ${screenshotPath}:`, statError);
        }
      } catch (error) {
        console.error(`Failed to capture ${animationFile}:`, error);
      } finally {
        await context.close();
      }

      if (captureSucceeded) {
        generatedScreenshots.push({
          name: screenshotFilename,
          path: path.relative(process.cwd(), screenshotPath),
        });
      } else {
        console.error(`Capture failed for ${animationFile}; see logs above.`);
        process.exitCode = 1;
      }
    }
  } finally {
    await browser.close();
  }

  if (generatedScreenshots.length > 0) {
    console.log('\nGenerated screenshots:');
    for (const { name, path: relativePath } of generatedScreenshots) {
      console.log(` - ${name}: ${relativePath}`);
    }

    const manifestPath = path.resolve(OUTPUT_DIR, SCREENSHOT_MANIFEST_FILENAME);
    const manifestEntries = [];

    for (const { name, path: relativePath } of generatedScreenshots) {
      const absolutePath = path.resolve(process.cwd(), relativePath);

      try {
        const fileBuffer = await fs.readFile(absolutePath);
        const base64 = fileBuffer.toString('base64');
        manifestEntries.push({
          name,
          path: relativePath,
          dataUri: `data:image/png;base64,${base64}`,
        });
      } catch (error) {
        console.warn(`Unable to embed ${relativePath} in manifest:`, error);
      }
    }

    try {
      await fs.writeFile(
        manifestPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            screenshots: manifestEntries,
          },
          null,
          2
        )
      );
      console.log(`\nScreenshot manifest written to ${path.relative(process.cwd(), manifestPath)}\n`);
    } catch (error) {
      console.warn('Failed to write screenshot manifest:', error);
    }
  }
})();
