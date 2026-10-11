import { readFileSync } from 'node:fs';

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const runId = Date.now().toString(36);

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

/** Direct API calls through the same proxied base the SPA uses, so cleanup never depends on the UI. */
async function call(request: APIRequestContext, token: string, method: string, path: string, data?: unknown) {
  return request.fetch(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { data: JSON.stringify(data) }),
  });
}

async function namedRows(request: APIRequestContext, token: string, listPath: string): Promise<{ id: string; name: string }[]> {
  const res = await call(request, token, 'GET', listPath);
  if (!res.ok()) return [];
  const body = (await res.json()) as { list?: { id: string; name: string }[] } | { id: string; name: string }[];
  return Array.isArray(body) ? body : (body.list ?? []);
}

/**
 * Deletes only records whose name carries this run's marker, after every test, so a failed run cannot
 * leave fixtures behind in the shared development database (AGENTS.md §3.3).
 */
async function sweep(request: APIRequestContext, token: string): Promise<void> {
  const where = encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: runId }]));
  for (const row of await namedRows(request, token, `/Account?maxSize=100&where=${where}`)) {
    await call(request, token, 'DELETE', `/Account/${row.id}`);
  }
  for (const row of await namedRows(request, token, '/SavedFilter')) {
    if (row.name.includes(runId)) await call(request, token, 'DELETE', `/SavedFilter/${row.id}`);
  }
  for (const row of await namedRows(request, token, '/Dashboard')) {
    if (row.name.includes(runId)) await call(request, token, 'DELETE', `/Dashboard/${row.id}`);
  }
}

async function pickOption(page: Page, label: string, option: string): Promise<void> {
  const item = page.locator('.ant-modal:visible .ant-form-item').filter({ has: page.locator('label', { hasText: label }) }).first();
  // antd re-renders its virtual option list while a click is in flight, so drive the search-enabled
  // combobox from the keyboard instead of aiming at the option element.
  await item.locator('.ant-select-selector').click();
  await page.keyboard.type(option);
  await page.locator('.ant-select-dropdown').last().waitFor({ state: 'visible' });
  await page.keyboard.press('Enter');
  await expect(item.locator('.ant-select').first()).toContainText(option);
}

function modalField(page: Page, label: string) {
  const item = page.locator('.ant-modal:visible .ant-form-item').filter({ has: page.locator('label', { hasText: label }) }).first();
  return item.locator('input').first();
}

function modalButton(page: Page, name: string) {
  return page.locator('.ant-modal:visible .ant-modal-footer').getByRole('button', { name });
}

test.describe('phase 12 — search, saved filters, csv and dashboards', () => {
  test.afterEach(async ({ request }) => {
    const token = await adminToken(request);
    await sweep(request, token);
  });

  test('the header search box lands on global search and finds the record', async ({ page, request }) => {
    const token = await adminToken(request);
    const name = `PW Global ${runId}`;
    const created = await call(request, token, 'POST', '/Account', { name, emailAddress: `pw${runId}@example.com` });
    expect(created.status()).toBe(201);

    await login(page);
    await page.locator('.lizant-header-search input').fill(name);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=/);
    await expect(page.getByRole('link', { name })).toHaveCount(1);

    // An email-only term proves the trigram-indexed attrs path, not just the name match.
    await page.locator('input[placeholder^="Search accounts"]').fill(`${runId}@example`);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('link', { name })).toHaveCount(1);
  });

  test('list text search, saved filter and the CSV import/export round-trip', async ({ page, request }) => {
    const token = await adminToken(request);
    const name = `PW List ${runId}`;
    expect((await call(request, token, 'POST', '/Account', { name })).status()).toBe(201);

    await login(page);
    await page.goto('/Account');
    await page.locator('input[placeholder^="Text search"]').fill(runId);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name })).toHaveCount(1);

    await page.getByRole('button', { name: 'Save current filters' }).click();
    await page.locator('.ant-modal:visible input[placeholder="Filter name"]').fill(`PW filter ${runId}`);
    await modalButton(page, 'Save').click();
    await expect(page.getByText('Filter saved.')).toBeVisible();

    const importedName = `PW Import ${runId}`;
    await page.getByRole('button', { name: 'Import CSV' }).click();
    await page.locator('.ant-modal:visible textarea').fill(`name,website\n"${importedName}",https://pw.example\n`);
    await modalButton(page, 'Import').click();
    await expect(page.getByText(/Imported: 1 created/)).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    expect(readFileSync(await download.path(), 'utf8')).toContain(importedName);
  });

  test('a dashboard with a KPI dashlet runs and can be deleted', async ({ page, request }) => {
    const token = await adminToken(request);
    await login(page);
    await page.goto('/dashboards');

    await page.getByRole('button', { name: 'New dashboard' }).click();
    await modalField(page, 'Name').fill(`PW Dashboard ${runId}`);
    await modalButton(page, 'Create').click();
    await expect(page.getByRole('button', { name: 'Add dashlet' })).toBeVisible();

    await page.getByRole('button', { name: 'Add dashlet' }).click();
    await modalField(page, 'Name').fill(`PW Accounts ${runId}`);
    await pickOption(page, 'Entity', 'Account');
    await modalButton(page, 'Add').click();
    await expect(page.locator('.ant-card').filter({ hasText: 'PW Accounts' }).locator('table')).toBeVisible();

    // A KPI dashlet added through the API must render its number after a refresh.
    const dashboards = await namedRows(request, token, '/Dashboard');
    const dashboardId = (dashboards.find((row) => row.name.includes(runId)) ?? { id: '' }).id;
    const added = await call(request, token, 'POST', `/Dashboard/${dashboardId}/dashlets`, {
      name: `PW Kpi ${runId}`, kind: 'kpi', position: 1, config: { entity: 'Account' },
    });
    expect(added.status()).toBe(201);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('.lizant-stat-value')).toBeVisible();
    expect((await page.locator('.lizant-stat-value').innerText()).replace(/[^0-9]/g, '')).not.toBe('');

    await page.getByRole('button', { name: 'Delete dashboard' }).click();
    await page.locator('.ant-popconfirm:visible, .ant-popover:visible').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: new RegExp(`PW Dashboard ${runId}`) })).toHaveCount(0);
  });
});
