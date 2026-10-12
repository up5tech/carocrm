import { readFileSync } from 'node:fs';

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const runId = Date.now().toString(36);

async function adminToken(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

test('Phase 17 — opens a saved report, runs it and exports CSV', async ({ page, request }) => {
  const token = await adminToken(request);
  const name = `AGENT_TEST_PW_Report_${runId}`;
  let accountId = '';
  let reportId = '';
  try {
    const account = await request.post('/api/v1/Account', {
      headers: { authorization: `Bearer ${token}` },
      data: { name },
    });
    expect(account.status()).toBe(201);
    accountId = (await account.json() as { id: string }).id;

    const report = await request.post('/api/v1/Report', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        name: `PW Report ${runId}`,
        visibility: 'private',
        definition: { entityType: 'Account', kind: 'list', filters: [{ field: 'name', operator: 'equalsExact', value: name }], columns: ['name'], metrics: [] },
      },
    });
    expect(report.status()).toBe(201);
    reportId = (await report.json() as { id: string }).id;

    await login(page);
    await page.goto('/reports');
    await page.getByRole('button', { name: `PW Report ${runId}` }).click();
    await page.getByRole('button', { name: 'Run / preview' }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    expect(readFileSync(await download.path(), 'utf8')).toContain(name);
  } finally {
    if (reportId !== '') await request.delete(`/api/v1/Report/${encodeURIComponent(reportId)}`, { headers: { authorization: `Bearer ${token}` } });
    if (accountId !== '') await request.delete(`/api/v1/Account/${encodeURIComponent(accountId)}`, { headers: { authorization: `Bearer ${token}` } });
  }
});
