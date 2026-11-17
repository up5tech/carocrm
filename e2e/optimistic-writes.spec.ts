import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 24.10.2/24.10.7 — optimistic writes in the browser.
 *
 * The Projects plan view flips a task's status pill before the round trip and puts the snapshot
 * back when the server refuses. This spec proves both halves against the real API: a transition on
 * a task that no longer exists is refused, the pill returns to "Not Started" and the refusal is
 * reported — the screen never keeps a status the server did not agree to.
 *
 * Everything is created through the API and deleted again afterwards (AGENTS.MD §3.3).
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const run = Date.now().toString(36);

async function login(page: Page): Promise<Record<string, string>> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  const token = await page.evaluate(() => window.localStorage.getItem('carocrm.accessToken') ?? '');
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

/** Delete a project and everything under it, children first (same contract as projects.spec.ts). */
async function deleteProjectTree(page: Page, projectId: string): Promise<void> {
  const token = await page.evaluate(() => window.localStorage.getItem('carocrm.accessToken'));
  const headers = { authorization: `Bearer ${token ?? ''}` };
  const plan = (await (await page.request.get(`/api/v1/Project/${projectId}/action/plan`, { headers })).json()) as {
    groups?: { tasks?: { id: string; parentTaskId?: string | null }[] }[];
  };
  const tasks = (plan.groups ?? []).flatMap((group) => group.tasks ?? []);
  for (const task of [...tasks.filter((entry) => entry.parentTaskId), ...tasks.filter((entry) => !entry.parentTaskId)]) {
    await page.request.delete(`/api/v1/ProjectTask/${task.id}`, { headers });
  }
  const dropped = await page.request.delete(`/api/v1/Project/${projectId}`, { headers });
  expect(dropped.ok(), `project ${projectId} was not deleted: ${String(dropped.status())}`).toBe(true);
}

test.describe('phase 24.10 optimistic writes', () => {
  test('a refused task transition rolls the optimistic status back', async ({ page }) => {
    test.setTimeout(120_000);
    const headers = await login(page);

    const projectName = `AGENT_TEST_Optimistic ${run}`;
    const taskName = `AGENT_TEST_Task ${run}`;
    let projectId = '';

    try {
      const project = await page.request.post('/api/v1/Project', {
        headers,
        data: { name: projectName, boardId: 'projectBoardDefault' },
      });
      expect(project.status(), JSON.stringify(await project.json().catch(() => ({})))).toBe(201);
      projectId = String((await project.json())['id']);

      const group = await page.request.post(`/api/v1/Project/${projectId}/action/groupCreate`, {
        headers,
        data: { name: `AGENT_TEST_group ${run}` },
      });
      expect(group.status()).toBe(200);
      const groupId = String((await group.json())['id']);

      const task = await page.request.post(`/api/v1/Project/${projectId}/action/taskCreate`, {
        headers,
        data: { projectId, groupId, name: taskName },
      });
      expect(task.status()).toBe(200);
      const taskId = String((await task.json())['id']);

      await page.goto(`/Project/${projectId}/plan`);
      const row = page.locator('.carocrm-project-task').filter({ hasText: taskName }).first();
      await expect(row.getByText('Not Started')).toBeVisible({ timeout: 15_000 });

      // The record disappears underneath the open page: the transition the UI is about to request
      // can only be refused, which is exactly the rollback path.
      // DELETE without a JSON content-type: Fastify rejects an empty body carrying one.
      const dropped = await page.request.delete(`/api/v1/ProjectTask/${taskId}`, { headers: { authorization: headers.authorization } });
      expect(dropped.ok(), `task delete failed: ${dropped.status()} ${await dropped.text()}`).toBe(true);

      await row.getByRole('button', { name: 'Complete' }).click();

      // The refusal must be reported and the predicted status must not survive.
      await expect(page.locator('.ant-message').first()).toBeVisible({ timeout: 15_000 });
      await expect(row.getByText('Not Started')).toBeVisible({ timeout: 15_000 });
      await expect(row.getByText('Completed')).toHaveCount(0);
    } finally {
      if (projectId !== '') await deleteProjectTree(page, projectId);
    }
  });
});
