import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('accessibility and responsive smoke (Phase 20 §13.5)', () => {
  test('core surfaces fit a 390px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await noHorizontalOverflow(page);

    await page.goto('/Contact');
    await expect(page).toHaveURL(/\/Contact/);
    await noHorizontalOverflow(page);

    const firstRow = page.getByRole('row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click();
      await noHorizontalOverflow(page);
    }

    await page.goto('/admin/settings');
    await noHorizontalOverflow(page);
  });

  test('keyboard reaches the command palette', async ({ page }) => {
    await login(page);
    await page.keyboard.press('Control+KeyK');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });
});

// Phase 20 §20.16 / §20.26: the "axe passes on the four core surfaces" criterion — home, list,
// record and settings (PLAN_Phase_20_Settings_UX.md §20.21 lists them). The scan is a real browser
// render, not a jsdom mock, so what axe sees is what a user gets. Only WCAG 2.0 A/AA rules run;
// "incomplete" results (axe needs the reviewer's eye) are not failures.
async function scanSurfaces(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return results.violations.map((v) => {
    const n = v.nodes[0];
    return `${v.id} (${v.impact}) — target: ${n?.target.join(' ')}\n    html: ${n?.html.slice(0, 160)}\n    fix: ${n?.failureSummary?.replace(/\s+/g, ' ').slice(0, 300)}`;
  });
}

test.describe('axe audit (Phase 20 §20.16, §20.26)', () => {
  let violations: string[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('home', async ({ page }) => {
    await page.goto('/home');
    await expect(page.getByRole('main')).toBeVisible({ timeout: 20_000 });
    violations = await scanSurfaces(page);
    expect(violations).toEqual([]);
  });

  test('list', async ({ page }) => {
    await page.goto('/Contact');
    // antd tables carry no ARIA grid role; the body itself is the stable marker.
    await expect(page.locator('.ant-table-tbody').first()).toBeVisible({ timeout: 20_000 });
    violations = await scanSurfaces(page);
    expect(violations).toEqual([]);
  });

  test('record', async ({ page }) => {
    await page.goto('/Contact');
    // An antd table body holds an aria-hidden measure row first; `data-row-key` selects the real
    // record rows only, so the click opens the record instead of a no-op header row.
    const firstRow = page.locator('tbody tr[data-row-key]').first();
    await expect(firstRow).toBeVisible({ timeout: 20_000 });
    await firstRow.click();
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(500);
    violations = await scanSurfaces(page);
    expect(violations).toEqual([]);
  });

  test('settings', async ({ page }) => {
    await page.goto('/admin/settings');
    await expect(page.locator('main, [role="main"]').first()).toBeVisible({ timeout: 20_000 });
    violations = await scanSurfaces(page);
    expect(violations).toEqual([]);
  });
});