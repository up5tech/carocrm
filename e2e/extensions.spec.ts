import { expect, type Page, test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

test.describe('extension administration (PLAN §38)', () => {
  test('shows the extension administration screen and the packages on disk', async ({ page }) => {
    await login(page);
    page.setDefaultTimeout(15_000);

    await page.getByRole('link', { name: 'Extensions', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/extensions/);
    await expect(page.getByRole('heading', { name: 'Extensions' })).toBeVisible();

    // `EXTENSIONS_DIR` decides what is listed; with the repository default there are none, and the
    // screen must say so rather than erroring.
    const rows = page.locator('.ant-table-row');
    const count = await rows.count();
    if (count === 0) {
      await expect(page.getByText(/EXTENSIONS_DIR/)).toBeVisible();
    } else {
      await expect(page.getByRole('cell', { name: 'account-health-fields' }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Install' }).first()).toBeVisible();
    }
  });
});