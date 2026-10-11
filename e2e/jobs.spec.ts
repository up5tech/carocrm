import { type APIRequestContext, expect, type Page,test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const runId = Date.now().toString(36);
const scheduleId = `pwJobs${runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 18)}`;

async function apiToken(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { accessToken: string }).accessToken;
}

/** Ids of jobs still waiting, so the cleanup can cancel exactly what this run created. */
async function pendingIds(request: APIRequestContext, token: string): Promise<string[]> {
  const res = await request.get('/api/v1/Job?status=pending&limit=100', { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok()) return [];
  const body = (await res.json()) as { list: { id: string }[] };
  return body.list.map((row) => row.id);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

test.describe('jobs administration (PLAN §24)', () => {
  test('saves a schedule, runs it, submits a one-off job and cancels it', async ({ page, request }) => {
    const token = await apiToken(request);
    const jobIds: string[] = [];

    try {
      await login(page);
      page.setDefaultTimeout(15_000);
      await page.getByRole('link', { name: 'Jobs', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/jobs/);
      await expect(page.getByRole('heading', { name: 'Scheduled jobs' })).toBeVisible();

      // 1. A cron schedule authored in the UI becomes a stored `scheduled_jobs` row.
      await page.getByPlaceholder('schedule id').fill(scheduleId);
      await page.getByPlaceholder('system.cleanupOutbox').first().fill('system.noop');
      await page.getByPlaceholder('0 * * * *').fill('0 * * * *');
      await page.getByRole('button', { name: 'Save schedule' }).click();
      await expect(page.getByText('Schedule saved.')).toBeVisible();

      const stored = await request.get('/api/v1/ScheduledJob', { headers: { authorization: `Bearer ${token}` } });
      const schedules = ((await stored.json()) as { list: { id: string; job: string; scheduling: string }[] }).list;
      expect(schedules.find((row) => row.id === scheduleId)).toMatchObject({ job: 'system.noop', scheduling: '0 * * * *' });

      // 2. "Run now" turns the schedule into a job row.
      const before = await pendingIds(request, token);
      const scheduleRow = page.locator('.ant-table-row').filter({ hasText: scheduleId });
      await scheduleRow.getByRole('button', { name: 'Run now' }).click();
      await expect(page.getByText('Queued system.noop.')).toBeVisible();
      jobIds.push(...(await pendingIds(request, token)).filter((id) => !before.includes(id)));

      // 3. A one-off job with data, through the modal.
      const runDialog = page.getByRole('dialog');
      await page.getByRole('button', { name: 'Run a job' }).click();
      await runDialog.getByLabel('Job').fill('system.noop');
      await runDialog.getByPlaceholder('{"retentionDays":7}').fill(`{"marker":"${runId}"}`);
      await page.getByRole('button', { name: 'OK' }).click();
      await expect(page.getByText('Queued system.noop.').last()).toBeVisible();

      // 4. The log drawer opens even when no worker has picked the job up yet.
      const pendingRow = page.locator('.ant-table-row').filter({ hasText: 'pending' }).first();
      await expect(pendingRow).toBeVisible();
      await pendingRow.getByRole('button', { name: 'Log' }).click();
      await expect(page.getByText(/Job log — system\.noop/)).toBeVisible();
      await expect(page.getByText('No log lines yet.')).toBeVisible();
      await page.getByRole('button', { name: 'Close' }).click();

      // 5. Cancellation of a waiting job is refused by nobody and recorded on the row.
      await pendingRow.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'OK' }).last().click();
      await expect(page.getByText('Cancellation requested.')).toBeVisible();

      const cancelled = await request.get('/api/v1/Job?status=cancelled&limit=50', { headers: { authorization: `Bearer ${token}` } });
      const list = (await cancelled.json()) as { list: { id: string; job: string }[] };
      expect(list.list.some((row) => row.job === 'system.noop')).toBe(true);

      const mine = await request.get(`/api/v1/Job?limit=100`, { headers: { authorization: `Bearer ${token}` } });
      const rows = (await mine.json()) as { list: { id: string; data?: Record<string, unknown> }[] };
      jobIds.push(...rows.list.filter((row) => row.data?.['marker'] === runId).map((row) => row.id));
    } finally {
      // No worker runs in this suite, so cancel anything still queued for this run and
      // disable the schedule: the rows stay as history, the queue stays clean (AGENTS.md §3.3).
      const headers = { authorization: `Bearer ${token}` };
      for (const id of jobIds) {
        await request.post(`/api/v1/Job/${id}/action/cancel`, { headers }).catch(() => undefined);
      }
      await request.post(`/api/v1/ScheduledJob/${scheduleId}/disable`, { headers }).catch(() => undefined);
    }
  });

  test('rejects a cron expression the scheduler could never parse', async ({ page, request }) => {
    const token = await apiToken(request);
    await login(page);
    page.setDefaultTimeout(15_000);
    await page.goto('/admin/jobs');

    await page.getByPlaceholder('schedule id').fill(`pwBad${runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}`);
    await page.getByPlaceholder('system.cleanupOutbox').first().fill('system.noop');
    await page.getByPlaceholder('0 * * * *').fill('99 * * * *');
    await page.getByRole('button', { name: 'Save schedule' }).click();

    await expect(page.getByText('Not a valid cron expression')).toBeVisible();

    const direct = await request.post('/api/v1/ScheduledJob', {
      headers: { authorization: `Bearer ${token}` },
      data: { id: 'pwBadApi', job: 'system.noop', scheduling: '99 * * * *' },
    });
    expect(direct.status()).toBe(422);
  });
});
