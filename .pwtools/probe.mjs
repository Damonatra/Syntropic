import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
await page.goto('http://localhost:3000/dashboard', { waitUntil: 'networkidle' });
await page.waitForSelector('.recharts-wrapper', { timeout: 15000 });
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const wrapper = document.querySelector('.recharts-wrapper');
  const svgs = [...(wrapper?.querySelectorAll('svg') ?? [])].map((s, i) => ({
    index: i,
    width: s.getAttribute('width'),
    height: s.getAttribute('height'),
    parentClass: s.parentElement?.getAttribute('class') ?? null,
    texts: [...s.querySelectorAll('text')].map((t) => t.textContent),
    pathCount: s.querySelectorAll('path').length,
    gCount: s.querySelectorAll('g').length,
    classList: [...new Set([...s.querySelectorAll('[class]')].map((e) => e.getAttribute('class')))],
  }));
  const allTexts = [...document.querySelectorAll('.recharts-wrapper text')].map((t) => t.textContent);
  return { svgCount: svgs.length, svgs, allTexts };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
