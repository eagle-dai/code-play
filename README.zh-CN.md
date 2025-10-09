# code-play

本仓库收集了一些小型 Web 示例和自动化工具，核心是一个借助 Playwright 的工作流，用于在 HTML 动画中快退和快进以捕获一致的参考帧。

## Anime.js 虚拟时间兼容补丁

Playwright 捕获脚本运行在 Chrome 的虚拟时间域中，该模式会跳过 `requestAnimationFrame` 回调。Anime.js 通常会在这些回调中切换 `began` 标记并触发 `begin`、`loopBegin` 等生命周期钩子，因此如果直接快进到 4 秒，`animejs-virtual-time.html` 页脚元素会保持隐藏状态。

为在保持自动化通用性的同时复现真实播放效果，脚本内置了一个可插拔的“框架补丁”注册表。每个补丁都会在页面脚本执行前注入，只在检测到目标框架时启用。当前注册表包含一个轻量的 anime.js 拦截器，用来恢复缺失的生命周期钩子：

* `requestAnimationFrame` 探针会统计初始 tick，确保自动化在取得首帧真实时间之前不会接管虚拟时间控制。
* 拦截器包装全局 `anime` 工厂（以及它创建的时间线），并在第一次虚拟时间 `seek()` 调用前预热实例的 `currentTime`。Anime.js 默认认为至少要有一个前置帧将 `currentTime` 推过零点才会触发大多数生命周期回调——包括 `begin`、`loopBegin`、`update` 和 `change*`。通过模拟该首帧，脚本让 anime.js 按正确顺序运行原生回调级联，后续钩子（`loopComplete`、`complete` 等）会像实时播放一样被触发。

依靠这些机制，虚拟时间捕获现在可以在默认的 4 秒时间点重现与真人观察者一致的 DOM 状态。

## 选择要捕获的动画

`npm run capture:animation` 接受一个位于 `assets/example/` 下的 HTML 文件名（不包含目录分隔符）。可以传入诸如 `animejs-virtual-time.html` 的具体文件名，或 `animejs-*.html`、`*.html` 这类通配模式。若通配符匹配到多个文件，脚本会使用相同配置顺序捕获。传入路径片段或额外参数会触发验证错误，因此只需提供文件名或模式即可。

## 运行动画捕获脚本

仓库提供的 `scripts/capture-animation-screenshot.js` 使用 [Playwright](https://playwright.dev/) 与 Chrome DevTools Protocol 虚拟时间，在 `assets/example/` 中的 HTML 动画示例里跳转到默认的 4 秒时间点并保存截图。脚本不会一次跳到终点，而是按 200 ms 的步长推进虚拟时间，每个时间点都会记录一帧，最终得到 4 秒的图像。这种逐帧推进与真实播放过程相匹配，使依赖生命周期的 UI 能保持同步。脚本会在接管虚拟时间前自动等待 120 ms 到 1 s 的真实时间，以获取足够的 RAF 引导 tick；在截图之间还会留出额外的真实时间（常规帧等待 50 ms，最终帧等待 1 s），确保延迟到达的 DOM 更新被写入图像。

配置与运行步骤如下：

1. **安装 Node.js 18+**：脚本已在现代 LTS 版本中验证，可通过 `node --version` 检查版本。
2. **安装依赖：**
   ```bash
   npm install
   ```
   该命令会安装 `package.json` 中声明的 Playwright。
3. **安装所需的浏览器二进制：**
   ```bash
   npx playwright install chromium
   ```
   脚本使用 Chromium 渲染动画。
4. **在 Linux 上安装 Chromium 依赖：**
   ```bash
   npx playwright install-deps
   ```
   精简的 Linux 环境可通过此命令安装 Chromium 需要的系统库；macOS 与 Windows 可跳过。
5. **（可选）让 Playwright 使用系统浏览器：**
   * 若要复用 Playwright 已知的 Chrome/Chromium 安装，可设置 `PLAYWRIGHT_BROWSER_CHANNEL`。例如：
     ```bash
     PLAYWRIGHT_BROWSER_CHANNEL=chrome npm run capture:animation -- animejs-virtual-time.html
     ```
     这样会使用操作系统提供的 Chrome Stable 渠道。
   * 若要指定某个可执行文件路径（例如便携版 Chromium），可设置 `PLAYWRIGHT_CHROME_EXECUTABLE`：
     ```bash
     PLAYWRIGHT_CHROME_EXECUTABLE="/usr/bin/google-chrome-stable" npm run capture:animation -- animejs-virtual-time.html
     ```
     当该变量存在时，`PLAYWRIGHT_BROWSER_CHANNEL` 会被忽略。
6. **运行捕获脚本（文件名或模式）：**
   ```bash
   npm run capture:animation -- animejs-virtual-time.html
   ```
   将 `animejs-virtual-time.html` 替换为 `assets/example/` 中想要捕获的 HTML 文件。也可以使用 `animejs-*.html` 或 `*.html` 这类通配模式批量捕获。脚本会拒绝指向示例目录以外的绝对或相对路径。截图文件（默认每帧间隔 200 ms）会自动写入 `tmp/output/`，命名形式如 `tmp/output/animejs-virtual-time-0000ms.png` 至 `tmp/output/animejs-virtual-time-4000ms.png`。输出目录会按需创建，文件名会被清理以避免目录分隔符泄漏到 `tmp/output/` 结构中。

## 验证环境

完成上述安装后，可通过以下命令确认环境已就绪：

1. 执行 `npm install` 安装依赖。
2. 运行 `npx playwright install chromium` 安装 Chromium（Linux 环境还需执行 `npx playwright install-deps` 安装系统库）。
3. 使用 `npm run capture:animation -- animejs-virtual-time.html` 捕获示例动画。成功时可在控制台看到保存的绝对路径，以及 `tmp/output/animejs-virtual-time-0000ms.png` 至 `tmp/output/animejs-virtual-time-4000ms.png` 等文件。若流程失败，脚本会给出可操作的提示，例如安装缺失的浏览器或检查目标 HTML 文件是否存在。

## 其他资源

* [README.md](README.md) — 英文版使用指南。
