import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = '/tmp/carocrm-review2';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:8080';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#userName', 'admin');
await page.fill('#password', 'admin');
await page.click('button[type="submit"]');
await page.waitForURL('**/home', { timeout: 20000 });

const shots = [
  ['/dashboards', '20-dashboards.png'],
  ['/stream', '21-stream.png'],
  ['/tasks', '22-tasks.png'],
  ['/admin/settings', '23-admin-settings.png'],
  ['/reports', '24-reports.png'],
  ['/Account/create', '25-create.png'],
];
for (const [path, name] of shots) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${OUT}/${name}`, fullPage: true });
}
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
console.log('DONE');
