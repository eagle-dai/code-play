# animejs-virtual-time screenshot mismatch

## Summary of observations
- The automated capture produced a frame that only shows the headline text and RAF timestamp overlay. The expected browser rendering also includes the browser/version string and timestamp in the lower-right corner.

## Root cause
1. The HTML keeps the `#chromeVer` and `#date` elements hidden (`visibility: hidden`) until the anime.js timeline flips them on. Their only visibility toggle happens inside the timeline step that runs a `begin` callback, which calls `tl.set(versionInfoTargets, { visibility: "visible" })`.【F:assets/example/animejs-virtual-time.html†L61-L69】【F:assets/example/animejs-virtual-time.html†L198-L207】
2. The capture script fast-forwards the page by repeatedly advancing Chromium's virtual time budget, then the page's own `setTimeout` immediately pauses and seeks the timeline to `STOP_AT_MS` (4 000 ms).【F:scripts/capture-animation-screenshot.js†L66-L77】【F:assets/example/animejs-virtual-time.html†L92-L213】
3. Jumping straight to the timeline's end means the version-info step never actually "plays"—the `begin` callback never fires—so the visibility toggle is skipped. As a result, both elements remain hidden when the screenshot is taken, while a real-time browser playback shows them after the animation finishes.

## Why virtual time skips the callback
- Chromium's virtual-time budget only advances timer-based tasks (e.g., `setTimeout`) and microtasks. It does **not** generate compositor frames, so `requestAnimationFrame` callbacks stay suspended while the budget drains. The anime.js timeline's updates—including the hook that dispatches `begin`—run from an internal `requestAnimationFrame` tick, meaning no ticks fire during virtual-time fast-forwarding.【F:assets/example/animejs-virtual-time.html†L121-L157】【F:assets/example/animejs-virtual-time.html†L185-L213】
- When the pending 4 000 ms timeout fires, the page pauses the timeline and seeks it straight to the target timestamp. Seeking updates properties instantly but, per anime.js behavior, it does not retroactively emit lifecycle callbacks such as `begin`. Therefore, the visibility-flip hook is skipped even if the virtual-time budget is consumed in tiny steps.【F:assets/example/animejs-virtual-time.html†L185-L213】

## Implication
Until the automation lets the anime.js timeline advance through the step that runs the `begin` callback (or otherwise ensures `#chromeVer`/`#date` visibility is toggled), captured frames will miss the browser/date footer.

## Practical workaround
- Let the page run for a fraction of real time immediately after loading—before enabling virtual-time fast-forwarding—so that the very first `requestAnimationFrame` tick fires. For example, the capture script now waits ~0.12 s (`INITIAL_REALTIME_WAIT_MS`) ahead of taking over the clock.【F:scripts/capture-animation-screenshot.js†L12-L17】【F:scripts/capture-animation-screenshot.js†L53-L62】
- Once that initial tick has dispatched, the anime.js `begin` handler makes the footer elements visible, and subsequent virtual-time jumps to 4 000 ms preserve the correct state for the screenshot. This approach keeps the automation generic because it does not depend on project-specific selectors—any animation framework that relies on an initial animation frame benefits from the brief real-time window.
