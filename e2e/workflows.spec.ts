import { expect, type Page, test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const runId = Date.now().toString(36);
const name = `pwWorkflow${runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

test.describe('workflow builder (PLAN §35)', () => {
  test('authors a workflow, publishes it and reads its history', async ({ page }) => {
    await login(page);
    page.setDefaultTimeout(20_000);

    await page.getByRole('link', { name: 'Workflows', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/workflows/);
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();

    // 1. Create a draft from the UI alone.
    await page.getByRole('button', { name: 'New workflow' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByText(`Workflow "${name}" created as a draft.`)).toBeVisible();
    await expect(page.getByRole('link', { name })).toBeVisible();

    // 2. A new workflow is not published and not enabled — nothing runs by accident.
    const row = page.locator('tr', { hasText: name });
    await expect(row.getByText('not published')).toBeVisible();

    // 3. Publish it; enabling stays a separate, explicit act.
    await row.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/published v1/)).toBeVisible();
    await row.getByRole('switch').check();
    await expect(row.getByText('published v1')).toBeVisible();

    // 4. The editor opens the definition and the flow is visible and editable.
    await page.getByRole('link', { name }).click();
    await expect(page).toHaveURL(/\/admin\/workflows\/.+/);
    await expect(page.getByText('draft v1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();

    // 5. Run history is part of the same page; with no worker running there is nothing yet.
    await expect(page.getByText('Run history')).toBeVisible();

    // Cleanup: delete the workflow this run created (AGENTS.md §3.3).
    await page.goto('/admin/workflows');
    const cleanupRow = page.locator('tr', { hasText: name });
    await cleanupRow.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText('Workflow deleted.')).toBeVisible();
  });
});