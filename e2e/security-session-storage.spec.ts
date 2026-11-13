import { expect, test } from '@playwright/test';

/**
 * Phase 23.10 — browser security spec for the documented token-storage residual
 * (`plans/PLAN_Phase_23_Security_Hardening.md` §16 task 3; `docs/security/data-retention.md`).
 *
 * The SPA keeps the **short-lived access token** in `localStorage` so a reload can reuse the
 * session (`apps/web/src/api/client.ts`). That is a deliberate, recorded residual: the token is
 * script-readable, so an XSS that achieves script execution can exfiltrate it. What must *not*
 * happen — and what this spec pins — is that the residual stays bounded:
 *
 *  1. the access token is the only credential in script-readable storage (no refresh token, no
 *     password, no API key, no second JWT anywhere in `localStorage`/`sessionStorage`);
 *  2. the refresh token lives only in the `HttpOnly` `CRM-REFRESH` cookie, which `document.cookie`
 *     cannot see, while the double-submit `CRM-CSRF` cookie is readable by design;
 *  3. a reload restores the session from that token alone (the behaviour the residual buys);
 *  4. signing out clears the stored token and both session cookies.
 *
 * If the SPA is later moved to a memory-only token, this spec fails on purpose: update it as part
 * of that change instead of deleting the assertion.
 */
const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const TOKEN_KEY = 'carocrm.accessToken';
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SESSION_COOKIES = ['CRM-REFRESH', 'CRM-CSRF'];

function decodeBase64Url(segment: string): string {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem('carocrm.locale', 'en'));
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

test.describe('Phase 23.10 — browser session storage', () => {
  test('keeps exactly one short-lived access token in script-readable storage', async ({ page }) => {
    await login(page);

    const storage = await page.evaluate(() => ({
      local: Object.entries({ ...window.localStorage }),
      session: Object.entries({ ...window.sessionStorage }),
      cookie: document.cookie,
    }));

    const token = storage.local.find(([key]) => key === TOKEN_KEY)?.[1] ?? null;
    expect(token).not.toBeNull();
    expect(token).toMatch(JWT_SHAPE);

    // The token is an `access` credential with a bounded lifetime, not a long-lived secret.
    const payload = JSON.parse(decodeBase64Url((token as string).split('.')[1] as string)) as {
      typ?: string;
      exp?: number;
      iat?: number;
      scope?: string;
    };
    expect(payload.typ).toBe('access');
    expect(typeof payload.exp).toBe('number');
    expect(typeof payload.iat).toBe('number');
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(3600);

    // No second JWT, refresh token or password in either script-readable store.
    const entries = [...storage.local, ...storage.session];
    expect(entries.filter(([, value]) => JWT_SHAPE.test(value)).map(([key]) => key)).toEqual([TOKEN_KEY]);
    // A value equal to the password would mean a credential was persisted; the i18n catalog is
    // text, so a substring search on a short word like "admin" would only match prose.
    expect(entries.filter(([, value]) => value === ADMIN.password)).toEqual([]);
    expect(entries.map(([key]) => key).filter((key) => /password|secret|refresh/i.test(key))).toEqual([]);

    // Refresh token: HttpOnly only. CSRF: readable by design (double submit).
    expect(storage.cookie).not.toContain('CRM-REFRESH');
    expect(storage.cookie).toContain('CRM-CSRF');
  });

  test('restores the session from the stored token after a reload', async ({ page }) => {
    await login(page);
    const before = await page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY);

    await page.reload();
    await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
    await expect(page.getByLabel('Password')).toHaveCount(0);

    const after = await page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY);
    expect(after).toBe(before);
  });

  test('signing out removes the stored token and both session cookies', async ({ page }) => {
    await login(page);

    await page.locator('.carocrm-avatar').first().click();
    await page.getByText(/sign out/i).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });

    const state = await page.evaluate(() => ({
      token: window.localStorage.getItem('carocrm.accessToken'),
      cookie: document.cookie,
    }));
    expect(state.token).toBeNull();
    for (const name of SESSION_COOKIES) expect(state.cookie).not.toContain(name);
  });
});
