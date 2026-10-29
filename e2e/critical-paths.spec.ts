import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };

const LOGIN_COPY: Record<string, { userName: string; password: string; submit: string }> = {
  en: { userName: 'User name', password: 'Password', submit: 'Sign in' },
  vi: { userName: 'Tên đăng nhập', password: 'Mật khẩu', submit: 'Đăng nhập' },
};

interface Creds {
  user: string;
  password: string;
}

async function login(page: Page, creds: Creds, locale = 'en'): Promise<void> {
  await page.addInitScript((l) => window.localStorage.setItem('carocrm.locale', l), locale);
  await page.goto('/login');
  const copy = LOGIN_COPY[locale];
  await page.getByLabel(copy.userName).fill(creds.user);
  await page.getByLabel(copy.password).fill(creds.password);
  await page.getByRole('button', { name: copy.submit }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

async function adminApi(): Promise<APIRequestContext> {
  const context = await request.newContext();
  const res = await context.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
  expect(res.ok()).toBeTruthy();
  const token = String((await res.json()).accessToken ?? '');
  return request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${token}` } });
}

test.describe('Phase 22.16 — browser E2E critical paths', () => {
  test('a refused login answers with the error state and a retry completes the journey', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('User name').fill(ADMIN.user);
    await page.getByLabel('Password').fill('AGENT_TEST_wrong_password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.ant-alert-error')).toBeVisible({ timeout: 20_000 });

    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  });

  test('the login screen renders the secondary enabled locale rather than an English fallback', async ({ page }) => {
    await page.addInitScript((l) => window.localStorage.setItem('carocrm.locale', l), 'vi');
    await page.goto('/login');
    await expect(page.getByLabel('Tên đăng nhập')).toBeVisible();
    await expect(page.getByLabel('Mật khẩu')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Đăng nhập' })).toBeVisible();
    await page.getByLabel('Tên đăng nhập').fill(ADMIN.user);
    await page.getByLabel('Mật khẩu').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  });

  test('a filtered list with no match answers with the empty state and its clear action', async ({ page }) => {
    const term = `AGENT_TEST_no_such_${Date.now().toString(36)}`;
    await login(page, ADMIN, 'en');
    await page.goto('/Lead');
    const filterArea = page.locator('.carocrm-filter');
    const operatorSelect = filterArea.locator('.ant-select').first();
    await operatorSelect.click();
    await page.keyboard.press('Enter');
    await expect(operatorSelect).toContainText('contains', { timeout: 10_000 });
    await filterArea.locator('input.ant-input').first().fill(term);
    await page.getByRole('button', { name: /Apply/ }).click();
    await expect(page.locator('.carocrm-empty')).toBeVisible();

    await page.locator('.carocrm-empty').getByRole('button', { name: 'Clear' }).click();
    await expect(page.locator('.carocrm-empty')).toHaveCount(0);
  });

  test('a caller without read access gets the denial card on a list surface', async ({ page }) => {
    const runId = Date.now().toString(36);
    const userName = `AGENT_TEST_p22_noaccess_${runId}`;
    const password = 'reader-pass-123';
    const admin = await adminApi();
    const created = await admin.post('/api/v1/User', {
      data: {
        userName,
        password,
        firstName: 'P22',
        lastName: 'Reader',
        emailAddress: `${userName}@example.com`,
        assignedRoleIds: ['noAccess'],
      },
    });
    expect(created.status()).toBe(201);
    const user = (await created.json()) as { id: string };

    try {
      await login(page, { user: userName, password });
      await page.goto('/Account');
      await expect(page.getByText('Access denied')).toBeVisible({ timeout: 20_000 });
    } finally {
      const removed = await admin.delete(`/api/v1/User/${user.id}`);
      expect(removed.status()).toBeLessThan(300);
      await admin.dispose();
    }
  });
});
