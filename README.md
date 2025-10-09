# code-play

This repository contains small web examples and automation helpers. The
primary utility is a Playwright-powered workflow that rewinds and fast forwards
HTML animations to capture consistent reference frames.

## Anime.js virtual time workaround

The Playwright capture script runs inside Chrome's virtual time domain, which
skips `requestAnimationFrame` callbacks. Anime.js normally toggles `began`
flags and fires lifecycle hooks such as `begin` and `loopBegin` during those
callbacks, so fast-forwarding directly to 4 seconds used to leave the footer
elements hidden in `animejs-virtual-time.html`.

To keep the automation generic while matching real playback, the script ships
with a pluggable "framework patch" registry. Each patch is injected before
page scripts execute and activates only when its target framework is present.
The current registry contains a lightweight anime.js interceptor that restores
missing lifecycle hooks:

* A `requestAnimationFrame` probe counts initial ticks so that the automation
  waits for the first frame of real time before seizing virtual time control.
* The interceptor wraps the global `anime` factory (and timelines it creates)
  and primes an instance's `currentTime` before the first virtual-time
  `seek()` call. Anime.js guards most lifecycle callbacks—`begin`, `loopBegin`,
  and even `update`/`change*`—behind the assumption that at least one prior
  frame has advanced `currentTime` beyond zero. By simulating that first frame
  we let anime.js run its native callback cascade in the correct order, so
  subsequent hooks (`loopComplete`, `complete`, etc.) fire exactly as they do
  during real playback.

With these pieces in place, virtual time captures reproduce the same DOM state
that a human viewer sees at the default 4-second mark.

## Selecting animations to capture

`npm run capture:animation` accepts a single HTML file name (without any
directory separators) that must live under `assets/example/`. You can supply
literal file names such as `animejs-virtual-time.html` or glob patterns such as
`animejs-*.html` and `*.html`. When a glob matches multiple files the script
captures each one sequentially using the same configuration. Supplying a path
segment or extra arguments causes the script to abort with a validation error,
so pass only the bare file name or pattern.

## Running the animation capture script

The repository provides `scripts/capture-animation-screenshot.js`, which uses
[Playwright](https://playwright.dev/) and Chrome DevTools Protocol virtual time
to jump to the default 4-second mark of an HTML animation example under
`assets/example/` and saves screenshots. Instead of jumping straight to the
end, the script advances virtual time in 200 ms increments and records a frame
at each step, culminating in the 4-second capture. This mirrors the state
changes an animation would experience frame by frame, which keeps
lifecycle-driven UI in sync with real playback. The script automatically waits
between 120 ms and 1 s of real time for bootstrap RAF ticks before seizing
virtual time, and it settles for an additional delay between captures (200 ms
frames use a 50 ms real-time pause; the final frame waits 1 s) so late-arriving
DOM updates make it into the screenshots.

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
     PLAYWRIGHT_BROWSER_CHANNEL=chrome npm run capture:animation -- animejs-virtual-time.html
     ```
     This uses the Chrome Stable channel shipped with your operating system.
   * To point at a specific executable path (for example a portable Chromium build), set `PLAYWRIGHT_CHROME_EXECUTABLE` instead:
     ```bash
     PLAYWRIGHT_CHROME_EXECUTABLE="/usr/bin/google-chrome-stable" npm run capture:animation -- animejs-virtual-time.html
     ```
     When this variable is present the channel setting is ignored.
6. **Run the capture script for a specific example (or pattern):**
   ```bash
   npm run capture:animation -- animejs-virtual-time.html
   ```
   Replace `animejs-virtual-time.html` with the HTML file you want to capture
   from `assets/example/`. You can also supply wildcard patterns such as
   `animejs-*.html` or `*.html` to capture multiple files in a single run. The
   script refuses absolute or relative paths outside the example directory. The
   script writes a series of screenshots (200 ms apart by default) such as
   `tmp/output/animejs-virtual-time-0000ms.png` through
   `tmp/output/animejs-virtual-time-4000ms.png`. The output directory is created
   on demand, and each file name is sanitized to avoid leaking directory
   separators into the `tmp/output/` tree.

If `playwright install-deps` is not available on your platform, refer to the list of packages documented in Playwright's [system requirements guide](https://playwright.dev/docs/intro#system-requirements).

## Verifying your setup

After following the installation steps, use the commands below to confirm your
environment is ready:

1. Install dependencies with `npm install`.
2. Install the Chromium browser binary with `npx playwright install chromium`
   (and, on Linux, system libraries via `npx playwright install-deps`).
3. Capture an example animation with
   `npm run capture:animation -- animejs-virtual-time.html`. You should see
   output similar to `tmp/output/animejs-virtual-time-0000ms.png` through
   `tmp/output/animejs-virtual-time-4000ms.png`, representing the 200 ms
   timeline. When the run succeeds the script prints the absolute paths to each
   saved file. Failures include actionable hints, such as installing missing
   browser binaries or verifying that the target HTML file exists.

## Additional resources

* [README.zh-CN.md](README.zh-CN.md) — Simplified Chinese translation of this
  guide.

## Formatting scripts

To keep code style consistent with the Prettier – Code formatter settings used in VS Code, run:

```bash
npm run format
```

This command applies Prettier's defaults to each JavaScript file directly inside `scripts/`, matching the formatting you would get from the VS Code extension.
