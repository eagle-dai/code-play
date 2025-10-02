# Agent Instructions

## Scope
These instructions apply to the entire repository.

## Development Principles
- Preserve the general-purpose nature of `scripts/capture-animation-screenshot.js`. The script must continue to fast-forward any HTML animation to a target time (default 4 s) using Playwright and CDP virtual time, without depending on project-specific selectors or timing quirks.
- Keep configurable values (e.g., target time, viewport, output naming) expressed as clear constants so future contributors can adapt the workflow for other animations.
- Handle missing assets and runtime failures gracefully with actionable error messages. Do not assume a particular set of demo files beyond generic HTML animation examples under `assets/example/`.
- Favor modern Node.js (18+) patterns: top-level async IIFEs, `async`/`await`, and native `fs/promises` APIs. Avoid adding new dependencies unless essential for automation stability.

## Testing and Verification
- Run `npm install` when package dependencies change or a fresh setup is required.
- Run `npx playwright install chromium` (and `npx playwright install-deps` on Linux) whenever the Chromium binary or its system dependencies might be missing on the target environment.
- Execute `npm run capture:animation` after modifying `scripts/capture-animation-screenshot.js`, the assets consumed by the script, or related automation infrastructure to ensure screenshots still match the expected 4-second visual state.
- Document in your testing summary which of the above commands were executed (or why they were not required).

## Documentation
- Update `README.md` whenever you change how contributors configure or run the capture workflow, or when defaults such as the fast-forward timestamp or output paths change.

## Git and PRs
- Use Conventional Commits for commit messages (e.g., `feat: ...`, `fix: ...`).
- Follow the platform instructions to generate a PR message with the provided tooling after committing your changes.
