# code-play

This repository contains small web examples and automation helpers.

## Anime.js virtual time workaround

The Playwright capture script runs inside Chrome's virtual time domain, which
skips `requestAnimationFrame` callbacks. Anime.js normally toggles `began`
flags and fires lifecycle hooks such as `begin` and `loopBegin` during those
callbacks, so fast-forwarding directly to 4 seconds used to leave the footer
elements hidden in `animejs-virtual-time.html`.

To keep the automation generic while matching real playback, the script now
ships with a pluggable "framework patch" registry. Each patch is injected
before page scripts execute and activates only when its target framework is
present. The current registry contains a lightweight anime.js interceptor that
restores missing lifecycle hooks:

* A `requestAnimationFrame` probe counts initial ticks so that the automation
  waits for the first frame of real time before seizing virtual time control.
* The interceptor wraps the global `anime` factory (and timelines it creates)
  and primes an instance's `currentTime` before the first virtual-time
  `seek()` call. Anime.js guards most lifecycle callbacks—`begin`,
  `loopBegin`, and even `update`/`change*`—behind the assumption that at least
  one prior frame has advanced `currentTime` beyond zero. By simulating that
  first frame we let anime.js run its native callback cascade in the correct
  order, so subsequent hooks (`loopComplete`, `complete`, etc.) fire exactly as
  they do during real playback.

With these two pieces in place, virtual time captures now reproduce the same
DOM state as a human viewer would see at the default 4-second mark.

## Running the animation capture script

The repository provides `scripts/capture-animation-screenshot.js`, which uses [Playwright](https://playwright.dev/) and Chrome DevTools Protocol virtual time to jump to the default 4-second mark of an HTML animation example under `assets/example/` and save a screenshot. The script advances virtual time in 250 ms steps before taking the default 4-second capture, which works reliably even when animations rely on per-frame state updates.

Follow these steps to configure your environment and run the script:

1. **Install Node.js 18+** (the script is tested with modern LTS versions). You can verify your version with `node --version`.
2. **Install dependencies:**
   ```bash
   npm install
   ```
   This installs Playwright as declared in `package.json`.
3. **Install the required browser binary:**
   ```bash
   npx playwright install chromium
   ```
   The script launches Chromium to render the animation.
4. **Install Chromium's Linux dependencies (if applicable):**
   ```bash
   npx playwright install-deps
   ```
   On minimal Linux environments this installs system libraries that Chromium needs. Skip this step on macOS/Windows.
5. **(Optional) Tell Playwright to use a system-installed browser:**
   * To reuse an existing Chrome or Chromium installation that Playwright knows how to launch, set `PLAYWRIGHT_BROWSER_CHANNEL`. For example:
     ```bash
     PLAYWRIGHT_BROWSER_CHANNEL=chrome npm run capture:animation
     ```
     This uses the Chrome Stable channel shipped with your operating system.
   * To point at a specific executable path (for example a portable Chromium build), set `PLAYWRIGHT_CHROME_EXECUTABLE` instead:
     ```bash
     PLAYWRIGHT_CHROME_EXECUTABLE="/usr/bin/google-chrome-stable" npm run capture:animation
     ```
     When this variable is present the channel setting is ignored.
6. **Run the capture script for a specific example:**
   ```bash
   npm run capture:animation -- animejs-virtual-time.html
   ```
   Replace `animejs-virtual-time.html` with the HTML file you want to capture from `assets/example/`. The script writes a series of screenshots (100 ms apart by default) such as `tmp/output/animejs-virtual-time-0000ms.png` through `tmp/output/animejs-virtual-time-4000ms.png`.

If `playwright install-deps` is not available on your platform, refer to the list of packages documented in Playwright's [system requirements guide](https://playwright.dev/docs/intro#system-requirements).

## Environment setup verification

The development container used for this check successfully followed the steps above:

1. Installed Node dependencies with `npm install`.
2. Downloaded the Chromium browser binaries via `npx playwright install chromium` and installed the Linux system libraries reported by Playwright using `npx playwright install-deps`.
3. Captured individual animations with commands such as `npm run capture:animation -- animejs-virtual-time.html`, which produced PNG files like `tmp/output/animejs-virtual-time-0000ms.png` and `tmp/output/animejs-virtual-time-4000ms.png`.

These commands complete without errors, confirming that the environment can be prepared according to the workflow described in `AGENTS.md`.
