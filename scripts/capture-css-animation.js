const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 320, height: 240 },
  });
  const page = await context.newPage();

  const targetPath = path.resolve(__dirname, '..', 'assets', 'example', 'css-animation.html');
  const fileUrl = `file://${targetPath}`;
  await page.goto(fileUrl, { waitUntil: 'load' });

  const client = await context.newCDPSession(page);

  await client.send('Emulation.setVirtualTimePolicy', {
    policy: 'pauseIfNetworkFetchesPending',
    budget: 0,
  });

  const budgetExpired = new Promise((resolve) =>
    client.once('Emulation.virtualTimeBudgetExpired', resolve)
  );

  await client.send('Emulation.setVirtualTimePolicy', {
    policy: 'pauseIfNetworkFetchesPending',
    budget: 4000,
  });

  await budgetExpired;

  // Force CSS animations to their state at the 4-second mark. Some animations
  // keep running indefinitely which can prevent the visual state from ever
  // settling when using virtual time alone, so we explicitly seek them.
  await page.evaluate((targetTimeMs) => {
    const animations = document.getAnimations();
    for (const animation of animations) {
      try {
        animation.currentTime = targetTimeMs;
        animation.pause();
      } catch (error) {
        console.warn('Failed to fast-forward animation', error);
      }
    }
  }, 4000);

  const screenshotPath = path.resolve(
    __dirname,
    '..',
    'tmp',
    'output',
    'css-animation-4s.png'
  );
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });

  await page.screenshot({
    path: screenshotPath,
  });

  await browser.close();
})();
