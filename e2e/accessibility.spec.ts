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

    const firstRow = page.locator('tbody tr').first();
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