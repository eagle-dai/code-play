# animejs-virtual-time screenshot mismatch

## Summary of observations
- The automated capture produced a frame that only shows the headline text and RAF timestamp overlay. The expected browser rendering also includes the browser/version string and timestamp in the lower-right corner.

## Root cause
1. The HTML keeps the `#chromeVer` and `#date` elements hidden (`visibility: hidden`) until the anime.js timeline flips them on. Their only visibility toggle happens inside the timeline step that runs a `begin` callback, which calls `tl.set(versionInfoTargets, { visibility: "visible" })`.【F:assets/example/animejs-virtual-time.html†L61-L69】【F:assets/example/animejs-virtual-time.html†L198-L207】
2. The capture script fast-forwards the page by repeatedly advancing Chromium's virtual time budget, then the page's own `setTimeout` immediately pauses and seeks the timeline to `STOP_AT_MS` (4 000 ms).【F:scripts/capture-animation-screenshot.js†L66-L77】【F:assets/example/animejs-virtual-time.html†L92-L213】
3. Jumping straight to the timeline's end means the version-info step never actually "plays"—the `begin` callback never fires—so the visibility toggle is skipped. As a result, both elements remain hidden when the screenshot is taken, while a real-time browser playback shows them after the animation finishes.
4. Internally, anime.js only marks an instance as "begun" when the prior frame's `currentTime` exceeded zero. A bare `seek()` from `0` to `STOP_AT_MS` updates animated values but never satisfies that condition, so lifecycle hooks such as `begin`/`loopBegin` stay dormant even when the `setTimeout` fast-forward runs to completion.【F:assets/example/anime32.min.js†L1-L1】

## Why virtual time skips the callback
- Chromium's virtual-time budget only advances timer-based tasks (e.g., `setTimeout`) and microtasks. It does **not** generate compositor frames, so `requestAnimationFrame` callbacks stay suspended while the budget drains. The anime.js timeline's updates—including the hook that dispatches `begin`—run from an internal `requestAnimationFrame` tick, meaning no ticks fire during virtual-time fast-forwarding.【F:assets/example/animejs-virtual-time.html†L121-L157】【F:assets/example/animejs-virtual-time.html†L185-L213】
- When the pending 4 000 ms timeout fires, the page pauses the timeline and seeks it straight to the target timestamp. Seeking updates properties instantly but, per anime.js behavior, it does not retroactively emit lifecycle callbacks such as `begin`. Therefore, the visibility-flip hook is skipped even if the virtual-time budget is consumed in tiny steps.【F:assets/example/animejs-virtual-time.html†L185-L213】

## Implication
Until the automation lets the anime.js timeline advance through the step that runs the `begin` callback (or otherwise ensures `#chromeVer`/`#date` visibility is toggled), captured frames will miss the browser/date footer.

## Why a simple RAF wait was insufficient
- Allowing a burst of real-time frames before switching to virtual time helps frameworks that bootstrap off early RAF ticks, but it still fails here: the page's own `setTimeout` pauses the timeline and issues a one-shot `seek(STOP_AT_MS)` after the fast-forward. Because the seek jumps from `currentTime = 0` directly to the target, anime.js never flips the `began` flag, so the `begin` callback that reveals the footer remains skipped.

## Practical workaround
- The capture script keeps the generic RAF bootstrap window to accommodate other demos, but now injects an additional init script that patches anime.js instances. The patch detects when a seek leaps forward from a resting `currentTime = 0` and manually runs the missing lifecycle hooks (marking `began`/`loopBegan` and invoking their handlers once) before the screenshot is taken.【F:scripts/capture-animation-screenshot.js†L57-L178】【F:scripts/capture-animation-screenshot.js†L216-L220】
- This interceptor wraps the global `anime` factory and timeline helper as soon as they load, so every instance—timelines and child animations alike—receives the safety shim without hard-coding any project-specific selectors or timings.【F:scripts/capture-animation-screenshot.js†L94-L178】
