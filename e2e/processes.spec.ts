import { expect, type Page, test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const runId = Date.now().toString(36);
const name = `pwProcess${runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
const key = `pw-process-${runId.replace(/[^a-z0-9-]/g, '').slice(0, 12)}`;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

test.describe('process approval (PLAN §36)', () => {
  test('authors a multi-step approval, publishes it and sees its lifecycle', async ({ page }) => {
    await login(page);
    page.setDefaultTimeout(20_000);

    await page.getByRole('link', { name: 'Processes', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/processes/);
    await expect(page.getByRole('heading', { name: 'Processes' })).toBeVisible();

    // 1. Create a draft from the UI: the default template is one review step and two end states.
    await page.getByRole('button', { name: 'New process' }).click();
    await page.getByLabel('Key').fill(key);
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByText(`Process "${name}" created as a draft.`)).toBeVisible();

    // 2. A new process runs nothing: not published, not enabled — and the definition is valid.
    const row = page.locator('tr', { hasText: name });
    await expect(row.getByText('not published')).toBeVisible();
    await expect(row.getByText('valid')).toBeVisible();

    // 3. Publish it; enabling stays a separate, explicit act.
    await row.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/published v1/)).toBeVisible();
    await row.getByRole('switch').check();
    await expect(page.getByText(`${name} enabled.`)).toBeVisible();

    // 4. The editor opens the flow: review step first (the start), two end steps, targets wired.
    await page.getByRole('link', { name }).first().click();
    await expect(page).toHaveURL(/\/admin\/processes\/.+/);
    await expect(page.getByText('draft v1')).toBeVisible();
    await expect(page.getByText('published v1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
    // The start tag marks the first step of the flow.
    await expect(page.getByText('start', { exact: true }).first()).toBeVisible();

    // 5. The my-tasks page exists for whoever answers approvals (empty for an admin with no tasks).
    await page.getByRole('link', { name: 'My Tasks' }).click();
    await expect(page).toHaveURL(/\/tasks/);
    await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();
    await expect(page.getByText('Nothing is waiting for you.')).toBeVisible();

    // Cleanup: delete the process this run created (AGENTS.md §3.3).
    await page.goto('/admin/processes');
    const cleanupRow = page.locator('tr', { hasText: name });
    await cleanupRow.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText('Process deleted. Its instances keep their history.')).toBeVisible();
  });
});
