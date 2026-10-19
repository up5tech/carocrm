import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 19-AI / §15 / §20 (19-AI.0–19-AI.20) — the AI Agents workspace in the browser.
 *
 * The journey a drafting administrator walks: open the workspace, read the capability-driven tabs,
 * define a draft agent through the guided form, and see the server refuse publication while the
 * configuration is incomplete (here: no model provider is configured in this environment). No model
 * is called — the run path stays behind the same `features.execution` and provider gates reviewed in
 * `ai-agent-runs.test.ts`, and the deterministic browser-observable boundary is what this spec
 * exercises.
 *
 * Everything this run creates is a uniquely named draft that is deleted again; the shared development
 * database keeps only its seeded configuration (AGENTS.MD §3.3).
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };

test.beforeAll(async ({ browser }) => {
  // This spec's key prefix is unique to it, so a crashed earlier run can still be finished safely:
  // only never-published drafts under that exact prefix are removed.
  const page = await browser.newPage();
  await login(page);
  const token = await page.evaluate(() => window.localStorage.getItem('carocrm.accessToken') ?? '');
  const list = await page.request.get('/api/v1/AIAgents/action/agents?maxSize=200&q=e2e-ui-agent-', {
    headers: { authorization: `Bearer ${token}` },
  });
  const rows = ((await list.json()) as { list?: { id: string; key: string; status: string }[] }).list ?? [];
  for (const draft of rows.filter((entry) => entry.key.startsWith('e2e-ui-agent-') && entry.status === 'draft')) {
    const removed = await page.request.delete(`/api/v1/AIAgents/action/agents/${draft.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!removed.ok()) throw new Error(`Could not remove leftover draft ${draft.key}: HTTP ${String(removed.status())}`);
  }
  await page.close();
});

async function login(page: Page): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  return page.evaluate(() => window.localStorage.getItem('carocrm.accessToken') ?? '');
}

test('an administrator drafts an agent and publication stays blocked until it is configured', async ({ page }) => {
  await login(page);

  await page.goto('/ai-agents');
  await expect(page.getByRole('heading', { name: 'AI Agents' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Runs', exact: true })).toBeVisible();
  // The overview reads the live platform: its features table names every capability it gates.
  await expect(page.getByText('Agent definitions and versions')).toBeVisible();
  await expect(page.getByText('Agent execution')).toBeVisible();

  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  const key = `e2e-ui-agent-${Date.now().toString(36)}`;
  const name = `E2E agent ${key}`;
  await page.getByRole('button', { name: 'New agent' }).click();
  await page.getByRole('textbox', { name: 'Key' }).first().fill(key);
  await page.getByRole('textbox', { name: 'Name' }).first().fill(name);
  await page.getByLabel('System instructions').fill('Read a summary of accessible accounts. Never take actions outside the granted tools.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Agent "${name}" saved.`)).toBeVisible();

  // Save succeeded: the toast confirms it and the drawer opens on the new draft automatically.
  await expect(page.getByText(`Agent "${name}" saved.`)).toBeVisible();
  // The draft detail drawer shows the provider is deliberately unresolved.
  await expect(page.getByRole('cell', { name: 'Not configured' })).toBeVisible();

  // Publication is blocked server-side while a provider is missing; the report names the exact gap.
  await page.getByRole('button', { name: 'Publish' }).first().click();
  const publishModal = page.getByRole('dialog').last();
  await expect(publishModal.getByText('Publish a new immutable version')).toBeVisible();
  await expect(publishModal.getByText('No provider connection is selected.')).toBeVisible();
  await publishModal.getByRole('button', { name: 'Publish' }).click();
  // The server refuses; the command returns an error and the review modal stays open for fixes.
  await expect(publishModal).toBeVisible();
  await expect(
    publishModal
      .getByText('The agent cannot be published while its validation report has blocking findings.')
      .or(publishModal.getByText('No provider connection is selected.'))
      .or(publishModal.getByText('Choose an enabled provider connection and model.'))
      .first(),
  ).toBeVisible();

  // Cleanup: only this run's unpublished draft, by exact id via the API.
  const token = await page.evaluate(() => window.localStorage.getItem('carocrm.accessToken') ?? '');
  const list = await page.request.get('/api/v1/AIAgents/action/agents?q=' + encodeURIComponent(key), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(list.ok()).toBe(true);
  const rows = ((await list.json()) as { list?: { id: string; key: string }[] }).list ?? [];
  const mine = rows.find((entry) => entry.key === key);
  expect(mine, 'the created draft should be listed by its unique key').toBeDefined();
  const removed = await page.request.delete(`/api/v1/AIAgents/action/agents/${String(mine?.id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(removed.ok()).toBe(true);
});
