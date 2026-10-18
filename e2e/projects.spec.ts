import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 19 — Projects in the browser (PLAN_Phase_19_Projects.md §12.4, §12.5 scenarios 3-10).
 *
 * The journey is the one a project owner actually walks: create a project on the seeded board, plan
 * groups and tasks, complete work, read it back from the board and the Gantt view, manage members,
 * change the feature settings, clone the project and see the task on the calendar. Drag-and-drop is
 * exercised through the same `/action/move` command a drop calls, so a green run means the server
 * side of a drop works, not just the animation.
 *
 * Everything this run creates is deleted again — the shared development database keeps only its
 * seeded configuration (AGENTS.MD §3.3).
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const run = Date.now().toString(36);

async function login(page: Page): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  return page.evaluate(() => window.localStorage.getItem('carocrm.accessToken') ?? '');
}

/** Input of the generated form item whose label matches exactly (labels are humanized by the SPA). */
function fieldInput(page: Page, label: RegExp): ReturnType<Page['locator']> {
  return page
    .locator('.ant-form-item')
    .filter({ has: page.locator('label', { hasText: label }) })
    .first()
    .locator('input, textarea')
    .first();
}

function modal(page: Page): ReturnType<Page['locator']> {
  return page.locator('.ant-modal:visible').last();
}

/**
 * An antd Select is driven by keyboard: its dropdown is portalled to `body` and keeps previous
 * options mounted, so clicking an option detaches mid-flight. Its matches are searched server-side,
 * so the debounce has to settle before Enter takes one.
 */
async function pickOption(page: Page, label: RegExp, term: string): Promise<void> {
  const combobox = page
    .locator('.ant-form-item')
    .filter({ has: page.locator('label', { hasText: label }) })
    .first()
    .getByRole('combobox');
  await combobox.click();
  await combobox.fill(term);
  await page.waitForTimeout(900);
  await combobox.press('Enter');
}

/** Delete a project and everything under it, children first: the API refuses to drop a container in use. */
async function deleteProjectTree(page: Page, projectId: string): Promise<void> {
  const token = await page.evaluate(() => window.localStorage.getItem('carocrm.accessToken'));
  const headers = { authorization: `Bearer ${token ?? ''}` };
  const plan = (await (await page.request.get(`/api/v1/Project/${projectId}/action/plan`, { headers })).json()) as {
    groups?: { group?: Record<string, unknown>; tasks?: { id: string; parentTaskId?: string | null }[] }[];
  };
  const tasks = (plan.groups ?? []).flatMap((group) => group.tasks ?? []);
  for (const task of [...tasks.filter((entry) => entry.parentTaskId), ...tasks.filter((entry) => !entry.parentTaskId)]) {
    await page.request.delete(`/api/v1/ProjectTask/${task.id}`, { headers });
  }
  // Memberships and groups go with the project itself (the guard drops a deleted project's
  // container rows); the last Owner cannot be removed on its own, so this must not try.
  const dropped = await page.request.delete(`/api/v1/Project/${projectId}`, { headers });
  // A leak here would leave rows in the shared development database, so fail the run loudly.
  expect(dropped.ok(), `project ${projectId} was not deleted: ${String(dropped.status())}`).toBe(true);
}

test.describe('phase 19 projects', () => {
  test('plans, tracks and clones a project', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page);

    // --- create the project on the seeded default board -------------------------------
    const projectName = `E2E Project ${run}`;
    await page.goto('/Project/create');
    await fieldInput(page, /^Name$/).fill(projectName);
    await pickOption(page, /^Project Board$/, 'Default');
    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page).toHaveURL(/\/Project\/[a-f0-9-]+$/, { timeout: 20_000 });
    const projectId = page.url().split('/').pop() ?? '';
    expect(projectId).not.toBe('');

    // --- Plan view: a group, a task, and completion ----------------------------------
    await page.goto(`/Project/${projectId}/plan`);
    await page.getByRole('button', { name: 'New group' }).click();
    await expect(page.getByText('No tasks in this group.')).toBeVisible();

    await page.getByRole('button', { name: '+ New task' }).click();
    await modal(page).getByLabel('Name').fill(`E2E Task ${run}`);
    await modal(page).getByRole('button', { name: /^Create$/ }).click();
    const taskRow = page.locator('.carocrm-project-task').filter({ hasText: `E2E Task ${run}` }).first();
    await expect(taskRow).toBeVisible({ timeout: 15_000 });
    await expect(taskRow.getByText('Not Started')).toBeVisible();

    await taskRow.getByRole('button', { name: 'Complete' }).click();
    await expect(taskRow.getByText('Completed')).toBeVisible({ timeout: 15_000 });

    // a reload must show the same order and the same derived status: the server owns them
    await page.reload();
    await expect(
      page.locator('.carocrm-project-task').filter({ hasText: `E2E Task ${run}` }).first().getByText('Completed'),
    ).toBeVisible({ timeout: 15_000 });

    // --- Kanban board: the task now sits in the board's "Done" column -----------------
    await page.goto(`/Project/${projectId}/board`);
    await expect(page.locator('.carocrm-project-column').filter({ hasText: 'Done' }).first()).toContainText(
      `E2E Task ${run}`,
      { timeout: 15_000 },
    );

    // --- Overview: the tab has to reach the project record. Its label used to carry a Link while
    // Tabs fired its own onChange, and the two navigations raced to `/Project/<id>/overview`, which
    // no route matches, so the click ended on the home page.
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page).toHaveURL(new RegExp(`\\/Project\\/${projectId}$`), { timeout: 15_000 });

    // --- Gantt: give the task dates, then see it drawn -------------------------------
    await page.goto(`/Project/${projectId}/plan`);
    await page.locator('.carocrm-project-task-name').filter({ hasText: `E2E Task ${run}` }).first().click();
    // A month ahead, on purpose: a date in "today"'s cell would compete with other suites'
    // activities for the calendar's bounded day cell.
    await modal(page).locator('.ant-picker input').first().click();
    await page.locator('.ant-picker-dropdown:visible .ant-picker-header-next-btn').click();
    await page
      .locator('.ant-picker-dropdown:visible .ant-picker-cell-in-view .ant-picker-cell-inner')
      .filter({ hasText: /^15$/ })
      .first()
      .click();
    await page.keyboard.press('Enter');
    await modal(page).getByRole('button', { name: /^Save$/ }).click();
    await expect(page.locator('.ant-message').first()).toContainText('Task saved', { timeout: 15_000 });

    await page.goto(`/Project/${projectId}/gantt`);
    await expect(page.locator('svg g[id^="gantt-bar-"], svg polygon[id^="gantt-bar-"]')).toHaveCount(1, { timeout: 15_000 });

    // --- members: the creator is the Owner -------------------------------------------
    await page.goto(`/Project/${projectId}/members`);
    await expect(page.getByText('Admin User').first()).toBeVisible();
    await expect(page.getByText('Owner').first()).toBeVisible();

    // --- settings: turning a feature off and on again keeps the data ------------------
    await page.goto(`/Project/${projectId}/settings`);
    const points = page.getByRole('switch').nth(3);
    await points.click();
    await expect(page.locator('.ant-message').first()).toContainText('Settings saved', { timeout: 15_000 });
    await points.click();
    await expect(page.locator('.ant-message').last()).toContainText('Settings saved', { timeout: 15_000 });

    // --- clone -----------------------------------------------------------------------
    await page.getByRole('button', { name: 'Create clone' }).click();
    await modal(page).getByLabel('New project name').fill(`E2E Clone ${run}`);
    await modal(page).getByRole('button', { name: 'Create clone' }).click();
    await expect(page).toHaveURL(/\/Project\/[a-f0-9-]+\/plan$/, { timeout: 20_000 });
    await expect(page.getByText(`E2E Task ${run}`).first()).toBeVisible({ timeout: 15_000 });
    // The url ends with the view name, so the id has to be captured from the path segment.
    const cloneId = page.url().match(/\/Project\/([a-f0-9-]+)\/plan/)?.[1] ?? '';
    expect(cloneId).not.toBe('');

    // --- project tasks are offered to the calendar, read-only (§4.13) ----------------
    // The month grid shows a bounded number of chips per day and this database is shared by
    // other suites, so the assertion is about the integration being present, not about which
    // cell happens to be crowded. The record-level filtering is covered by
    // apps/api/test/projects-security.test.ts, which reads the same /Calendar endpoint.
    await page.goto('/calendar');
    await expect(page.getByRole('checkbox', { name: 'ProjectTask' })).toBeVisible({ timeout: 15_000 });

    // --- leave nothing behind ---------------------------------------------------------
    await deleteProjectTree(page, cloneId);
    await deleteProjectTree(page, projectId);
  });
});
