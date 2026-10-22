import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:3000/dashboard';
const out = process.argv[3] ?? '../artifacts/dashboard-3000.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
console.log('HTTP status:', response?.status());

// Wait for Recharts to mount + finish its entry animation
await page.waitForSelector('.recharts-wrapper svg', { timeout: 15000 });
await page.waitForTimeout(2500);

const report = await page.evaluate(() => {
  const main = document.querySelector('main');
  const mainBg = main ? getComputedStyle(main).backgroundColor : null;
  const wrapper = document.querySelector('.recharts-wrapper');
  const chartSvg = wrapper?.querySelector('svg') ?? null;
  const areaPaths = chartSvg
    ? [...chartSvg.querySelectorAll('path')].filter((p) => (p.getAttribute('d') ?? '').length > 40)
    : [];
  const xLabels = [...document.querySelectorAll('.recharts-xAxis text')].map((t) => t.textContent);
  const yLabels = [...document.querySelectorAll('.recharts-yAxis text')].map((t) => t.textContent);
  const legend = [...document.querySelectorAll('.recharts-legend-item text')].map((t) => t.textContent);

  // ROI card: find the card whose heading mentions ROI Multiple
  const cards = [...document.querySelectorAll('main > div > div')];
  const roiHeading = [...document.querySelectorAll('span')].find(
    (s) => s.textContent?.trim() === 'Syntropic ROI Multiple',
  );
  const roiCard = roiHeading?.closest('div.rounded-xl') ?? null;
  const roiValue = roiCard
    ? [...roiCard.querySelectorAll('div')].find((d) => /^\d+(\.\d+)?x$/.test(d.textContent?.trim() ?? ''))
    : null;

  const banner = [...document.querySelectorAll('div')].find((d) =>
    /Syntropic has generated/.test(d.textContent ?? ''),
  );

  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  const r = rect(wrapper);

  return {
    mainBg,
    chart: {
      present: Boolean(wrapper && chartSvg),
      wrapperWidth: Math.round(r?.width ?? 0),
      wrapperHeight: Math.round(r?.height ?? 0),
      areaPathCount: areaPaths.length,
      xLabels,
      yLabelCount: yLabels.length,
      legend,
    },
    roiCard: {
      headingFound: Boolean(roiHeading),
      value: roiValue?.textContent?.trim() ?? null,
      valueColor: roiValue ? getComputedStyle(roiValue).color : null,
      headingColor: roiHeading ? getComputedStyle(roiHeading).color : null,
    },
    bannerText: banner?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 220) ?? null,
    documentTitle: document.title,
  };
});

console.log(JSON.stringify(report, null, 2));
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');

await page.screenshot({ path: out, fullPage: true });
console.log('screenshot saved:', out);

await browser.close();
