import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 19-INT.14 / 19-INT.15 / 19-INT.16–19-INT.24 — the Advanced Integrations workspace in the
 * browser.
 *
 * The **catalog** is now populated: nine connectors are registered in code, so an administrator
 * sees them before connecting anything. What is still empty is everything that requires a
 * connection — the connections, the mappings, the runs and the conflicts — and those empty states
 * are what this spec checks, together with the capability gating.
 *
 * The fake provider is **not** registered in a production build, so the catalog a browser sees
 * holds only the nine real connectors.
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

  // The catalog holds the delivered connectors. A visible row is an *available* connector, never a
  // configured one — the connections tab is where that is shown.
  await expect(page.getByText('Google Workspace', { exact: true })).toBeVisible();
  await expect(page.getByText('Stripe', { exact: true })).toBeVisible();
  await expect(page.getByText('Generic REST API', { exact: true })).toBeVisible();
  // The fake provider is never registered in a production build.
  await expect(page.getByText('Fake provider', { exact: true })).toHaveCount(0);

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
