import { expect, type Page, test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const runId = Date.now().toString(36);
const subject = `PW Email ${runId}`;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

function fieldInput(page: Page, label: string) {
  const item = page
    .locator('.ant-form-item')
    .filter({ has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) })
    .first();
  return item.locator('input, textarea').first();
}

/**
 * The Email entity is metadata-driven, so the generated list/detail/edit views are its UI; only the
 * send action is a real API call. Everything created here is deleted again (AGENTS.md §3.3).
 */
test.describe('outbound email record (PLAN §28)', () => {
  test('a draft created in the generated form can be queued and its ledger is readable', async ({ page, request }) => {
    const token = await (async () => {
      const res = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
      expect(res.ok()).toBeTruthy();
      return ((await res.json()) as { accessToken: string }).accessToken;
    })();
    const headers = { authorization: `Bearer ${token}` };

    await login(page);
    await page.goto('/Email/create');
    await fieldInput(page, 'Subject').fill(subject);
    await fieldInput(page, 'From Address').fill(`Sales <sales-${runId}@crm.example>`);
    await fieldInput(page, 'To').fill(`one-${runId}@example.com, two-${runId}@example.com`);
    await fieldInput(page, 'Body').fill('Written from the generated form.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(/\/Email\/[0-9a-f-]{36}$/, { timeout: 20_000 });
    const id = page.url().split('/').pop() as string;

    // The record shows up in the generated list like any other entity.
    await page.goto('/Email');
    await expect(page.getByRole('link', { name: subject })).toHaveCount(1);

    const transport = await request.get('/api/v1/Email/action/transport', { headers });
    expect(transport.ok()).toBeTruthy();
    const info = (await transport.json()) as { name: string; mode: string; maxRecipients: number };
    expect(['none', 'memory']).toContain(info.name);
    expect(info.maxRecipients).toBeGreaterThan(0);

    const send = await request.post(`/api/v1/Email/${id}/action/send`, { headers });
    if (info.name === 'none') {
      // An installation without a mail account must refuse instead of queueing dead work.
      expect(send.status()).toBe(403);
      expect((await send.json()).error.code).toBe('FEATURE_DISABLED');
    } else {
      expect(send.ok()).toBeTruthy();
      const queued = (await send.json()) as {
        email: { status: string };
        deliveries: { status: string; recipientType: string }[];
        job: { id: string; name: string };
      };
      expect(queued.email.status).toBe('Queued');
      expect(queued.deliveries).toHaveLength(2);
      expect(queued.deliveries.every((row) => row.status === 'pending')).toBe(true);
      expect(queued.job.name).toBe('system.sendEmail');

      // Cancel the queued send, so nothing is left for a later worker to execute (§3.3). The
      // cancelled job row stays as the audit trail of this attempt.
      const cancel = await request.post(`/api/v1/Job/${queued.job.id}/action/cancel`, { headers });
      expect(cancel.ok()).toBeTruthy();

      const ledger = await request.get(`/api/v1/Email/${id}/deliveries`, { headers });
      expect(ledger.ok()).toBeTruthy();
    }

    await request.delete(`/api/v1/Email/${id}`, { headers });
    await page.goto('/Email');
    await expect(page.getByRole('link', { name: subject })).toHaveCount(0);
  });
});
