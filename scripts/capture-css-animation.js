const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 320, height: 240 },
  });
  const page = await context.newPage();

  const targetPath = path.resolve(__dirname, '..', 'assets', 'example', 'css-animation.html');
  const fileUrl = `file://${targetPath}`;
  await page.goto(fileUrl);

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

  await page.screenshot({
    path: path.resolve(__dirname, '..', 'assets', 'example', 'css-animation-4s.png'),
  });

  await browser.close();
})();
