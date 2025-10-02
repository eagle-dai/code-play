# code-play

This repository contains small web examples and automation helpers.

## Running the animation capture script

The repository provides `scripts/capture-animation-screenshot.js`, which uses [Playwright](https://playwright.dev/) and Chrome DevTools Protocol virtual time to jump to the 4-second mark of any HTML animation example under `assets/example/` and save a screenshot. The script advances virtual time in 250 ms steps before taking the 4-second capture, which works reliably even when animations rely on per-frame state updates.

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
5. **Run the capture script:**
   ```bash
   npm run capture:animation
   ```
   The script automatically iterates over every HTML example in `assets/example/` and writes screenshots to `tmp/output/<animation-name>-4s.png`.

If `playwright install-deps` is not available on your platform, refer to the list of packages documented in Playwright's [system requirements guide](https://playwright.dev/docs/intro#system-requirements).

## Environment setup verification

The development container used for this check successfully followed the steps above:

1. Installed Node dependencies with `npm install`.
2. Downloaded the Chromium browser binaries via `npx playwright install chromium` and installed the Linux system libraries reported by Playwright using `npx playwright install-deps`.
3. Captured the animation set with `npm run capture:animation`, which produced PNG files such as `tmp/output/css-animation-4s.png` and `tmp/output/web-animations-virtual-time-4s.png`.

These commands complete without errors, confirming that the environment can be prepared according to the workflow described in `AGENTS.md`.
