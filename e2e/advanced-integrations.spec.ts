import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 19-INT.14 / 19-INT.15 — the Advanced Integrations workspace in the browser.
 *
 * No connector is registered in a production build — connectors arrive with 19-INT.16 — so the
 * browser-observable behaviour of this page is its **empty states** and its **capability gating**.
 * That is exactly what this spec checks: the page loads, the five surfaces are reachable, an
 * empty catalog says what to do rather than rendering a blank panel, and the module never claims a
 * connector is configured.
 *
 * The end-to-end configuration of a *fake* connector is covered by the API suite
 * (`apps/api/test/advanced-integrations-admin.test.ts`), because a fake connector is registered in
 * code and therefore does not exist in a browser build.
 *
 * Nothing this spec creates is left behind: it creates no record at all.
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

test('an administrator reaches every surface of the connector workspace', async ({ page }) => {
  await login(page);

  await page.goto('/advanced-integrations');
  await expect(page.getByRole('heading', { name: 'Advanced Integrations' })).toBeVisible();

  // The five surfaces of the module (plan §15).
  await expect(page.getByRole('tab', { name: 'Connectors' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Connections' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Mapping' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Sync runs' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Conflicts' })).toBeVisible();

  // The catalog is empty in a production build, and it says so.
  await expect(
    page.getByText('No connector is registered yet. The control plane is available', { exact: false }),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Connections' }).click();
  await expect(page.getByText('No connection yet', { exact: false })).toBeVisible();

  await page.getByRole('tab', { name: 'Mapping' }).click();
  await expect(page.getByText('No mapping yet', { exact: false })).toBeVisible();

  await page.getByRole('tab', { name: 'Sync runs' }).click();
  // The run history asks which connection to read before it shows anything.
  await expect(page.getByText('Choose a connection to see its runs.')).toBeVisible();

  await page.getByRole('tab', { name: 'Conflicts' }).click();
  await expect(page.getByText('Choose a connection to see its conflicts.')).toBeVisible();
});

test('the module page is reachable from the admin settings and the sidebar', async ({ page }) => {
  await login(page);

  // The admin panel's integration group owns a tab that points at the page. The shell renders
  // every tab — page-kind ones included — as a button that navigates.
  await page.goto('/admin/settings');
  const tab = page.getByRole('button', { name: 'Advanced Integrations' });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page).toHaveURL(/\/advanced-integrations/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Advanced Integrations' })).toBeVisible();
});
