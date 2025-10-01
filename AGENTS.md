# Agent Instructions

- Follow conventional commit style when crafting git commit messages.
- When working on code that ships to users (scripts, assets, etc.), ensure the project still builds and tests successfully:
  - Install dependencies with `npm install` if you have not already.
  - Run `npm run build` when a build script is available.
  - Run `npm test` to execute the automated test suite.
  - Execute any feature-specific scripts such as `npm run capture:animation` when your change impacts them.
- Note which commands were executed (or why they were skipped) in your testing summary.
