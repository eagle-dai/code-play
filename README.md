# code-play

This repository contains small web examples and automation helpers.

## Running the CSS animation capture script

The `scripts/capture-css-animation.js` script uses [Playwright](https://playwright.dev/) and Chrome DevTools Protocol virtual time to jump to the 4-second mark of `assets/example/css-animation.html` and save a screenshot.

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
   npm run capture:css-animation
   ```
   The screenshot will be written to `assets/example/css-animation-4s.png`.

If you are running in a minimal Linux environment, you may also need system libraries required by Chromium. Playwright documents the list of packages for each distribution in its [installation guide](https://playwright.dev/docs/intro#system-requirements).
