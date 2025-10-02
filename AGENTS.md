# Agent Instructions

- Use conventional commit style for git commit messages.
- When working on scripts or assets, make sure the Playwright capture workflow described in the README keeps working:
  - Install dependencies with `npm install`.
  - Install the required Playwright browser binary with `npx playwright install chromium` (only needs to be done once per environment).
- Run `npm run capture:animation` to capture the full animation set under `assets/example/` if your change could affect the capture script output.
- Note which of the above commands were executed (or why they were skipped) in your testing summary.
