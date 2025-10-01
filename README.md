# code-play

This repository contains small web examples and automation helpers.

## Running the animation capture script

The `scripts/capture-animation-screenshot.js` script uses [Playwright](https://playwright.dev/) and Chrome DevTools Protocol virtual time to jump to the 4-second mark of any HTML animation example under `assets/example/` and save a screenshot.

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
4. **Run the capture script:**
   ```bash
   npm run capture:animation -- css-animation.html
   ```
   Replace `css-animation.html` with the relative path of the animation file inside `assets/example/`. The screenshot will be written to `tmp/output/<animation-name>-4s.png`.

If you are running in a minimal Linux environment, you may also need system libraries required by Chromium. Playwright documents the list of packages for each distribution in its [installation guide](https://playwright.dev/docs/intro#system-requirements).
