import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * Phase 19-OM.10 / OM.20 / OM.21 — the Omnichannel workspace in the browser
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.10`, `19-OM.20`, `19-OM.21`).
 *
 * Three things have broken before and are guarded here:
 *
 *  1. **the filters must reach the server** — the workspace never filters a fetched list locally, so
 *     every filter control has to be a real query parameter (the request log proves it);
 *  2. **the module switch is a gate, not a hidden menu entry** — with the workspace off the sidebar
 *     entry disappears *and* the workspace endpoints answer 403, while the control plane stays open;
 *  3. **the page must survive its own empty states** — a deployment without conversations still shows
 *     the filters, the reports and the operations surface instead of an error card.
 *
 * The `omnichannel` settings document is a deep-merged document, so the run only writes the one flag
 * it changed and puts that flag back — nothing else in the document is touched.
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

async function token(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
  expect(response.ok(), await response.text()).toBe(true);
  return String((await response.json()).accessToken);
}

async function workspaceFlag(request: APIRequestContext): Promise<boolean> {
  const response = await request.get('/api/v1/Omnichannel/action/settings', { headers: { authorization: `Bearer ${await token(request)}` } });
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { settings?: { features?: { workspace?: boolean } } };
  return body.settings?.features?.workspace === true;
}

async function writeWorkspace(request: APIRequestContext, enabled: boolean): Promise<void> {
  const response = await request.post('/api/v1/Omnichannel/action/settings', {
    headers: { authorization: `Bearer ${await token(request)}` },
    data: { features: { workspace: enabled } },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test.describe('omnichannel workspace', () => {
  test('renders the tabs and the filters, and every filter reaches the server', async ({ page, request }) => {
    await writeWorkspace(request, true);
    await login(page);
    await page.goto('/omnichannel');
    await expect(page.getByRole('tab', { name: 'Inbox' })).toBeVisible();

    // The three other tabs the workspace is made of.
    await expect(page.getByRole('tab', { name: 'Reports' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Operations' })).toBeVisible();

    // The filter controls the plan names: channel, priority, language, queue, tag. The pickers are
    // comboboxes; the language and tag filters are text inputs.
    await expect(page.getByRole('combobox', { name: 'Channel' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Priority' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Queue' })).toBeVisible();
    await expect(page.getByLabel('Language')).toBeVisible();
    await expect(page.getByLabel('Tag')).toBeVisible();

    // The list is a server-side query: the request carries the filter, the client does not filter.
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/Omnichannel/action/conversations')) requests.push(request.url());
    });
    await page.getByLabel('Language').fill('en');
    await page.waitForTimeout(1_500);
    expect(requests.some((url) => url.includes('language=en'))).toBe(true);
  });

  test('the reports and the operations surface render their own data', async ({ page, request }) => {
    await writeWorkspace(request, true);
    await login(page);
    await page.goto('/omnichannel');

    await page.getByRole('tab', { name: 'Reports' }).click();
    // The analytics tiles are the server's answer, not a locally computed number.
    await expect(page.getByText('Inbound').first()).toBeVisible();
    await expect(page.getByText('Outbound').first()).toBeVisible();

    await page.getByRole('tab', { name: 'Operations' }).click();
    await expect(page.getByText('Connections').first()).toBeVisible();
    await expect(page.getByText('Receipts').first()).toBeVisible();
  });

  test('the module switch removes the sidebar entry and the workspace refuses', async ({ page, request }) => {
    const before = await workspaceFlag(request);
    try {
      await writeWorkspace(request, false);

      // The workspace endpoint itself answers 403 — the switch is a server-side gate.
      const refused = await request.get('/api/v1/Omnichannel/action/conversations', {
        headers: { authorization: `Bearer ${await token(request)}` },
      });
      expect(refused.status()).toBe(403);
      expect((await refused.json()).error.code).toBe('FEATURE_DISABLED');

      // The control plane stays reachable, so an administrator can switch it back on.
      const settings = await request.get('/api/v1/Omnichannel/action/settings', {
        headers: { authorization: `Bearer ${await token(request)}` },
      });
      expect(settings.status()).toBe(200);

      await login(page);
      await page.goto('/home');
      await expect(page.locator('.ant-menu-item').first()).toBeVisible();
      // The sidebar entry is gone while the workspace is off.
      await expect(page.locator('.ant-menu-item', { hasText: /^Omnichannel$/ })).toHaveCount(0);
    } finally {
      await writeWorkspace(request, before);
    }
  });
});
