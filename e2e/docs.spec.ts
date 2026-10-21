import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';

/**
 * Phase 21 — the handbook in the browser (PLAN_Phase_21_Documentation.md §13.5, five scenarios).
 *
 * These are the five things a reader actually does, and each one has broken before: the sidebar entry is
 * gated on a settings document, the tree is filtered by what the caller may read, the search has to answer
 * a Vietnamese phrase typed without diacritics, and an anchor has to move focus as well as scroll.
 *
 * The API matrix in `apps/api/test/docs.test.ts` covers the same rules on the server; this spec proves the
 * SPA honours them too. The only record this run creates is one reader account, deleted afterwards
 * (AGENTS.MD §3.3) — the platform's delete is a soft delete, so a repeated run leaves inert
 * `AGENT_TEST_p21_reader_*` rows behind until an operator purges them.
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const RUN = Date.now().toString(36);
const READER = { userName: `AGENT_TEST_p21_reader_${RUN}`, password: 'reader-pass-123' };

async function login(page: Page, user = ADMIN.user, password = ADMIN.password): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(user);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  return page.evaluate(() => window.localStorage.getItem('carocrm.accessToken') ?? '');
}

/** The vite dev server proxies `/api`, so the API is reached through the page origin. */
async function adminApi(): Promise<APIRequestContext> {
  const context = await request.newContext();
  const res = await context.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
  expect(res.ok()).toBeTruthy();
  const token = String((await res.json()).accessToken ?? '');
  return request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${token}` } });
}

let api: APIRequestContext;
let readerId = '';

test.beforeAll(async () => {
  api = await adminApi();
  const created = await api.post('/api/v1/User', {
    data: {
      userName: READER.userName,
      password: READER.password,
      firstName: 'Docs',
      lastName: 'Reader',
      emailAddress: `${READER.userName}@example.com`,
      assignedRoleIds: ['noAccess'],
    },
  });
  expect(created.status()).toBe(201);
  readerId = String((await created.json()).id);
});

test.afterAll(async () => {
  if (readerId !== '') {
    const gone = await api.delete(`/api/v1/User/${readerId}`);
    expect(gone.status()).toBeLessThan(300);
  }
  await api.dispose();
});

test('1. the sidebar opens the handbook, and an administrator sees every section', async ({ page }) => {
  await login(page);

  // §5.9 and §13.6: the skip link is the first focusable thing on the page, and one <main> holds the reader.
  await page.keyboard.press('Tab');
  await expect(page.locator('.carocrm-skip-link')).toBeFocused();
  await expect(page.locator('main')).toHaveCount(1);

  await page.getByRole('link', { name: 'Documentation', exact: true }).first().click();
  await expect(page).toHaveURL(/\/docs$/);
  // Web-first: the landing renders once the tree query lands, so wait on the doors themselves.
  await expect(page.locator('.carocrm-doc-door')).toHaveCount(4);
  await expect(page.locator('.carocrm-doc-door-title', { hasText: 'Administrator handbook' })).toBeVisible();
  await expect(page.locator('.carocrm-doc-door-title', { hasText: 'CRM user guide' })).toBeVisible();
});

test('2. a user page renders prose and a TOC, and "Open this screen" goes to the screen it documents', async ({ page }) => {
  await login(page);
  await page.goto('/docs/user/lists-and-views');
  await expect(page.locator('h1')).toHaveText('Working with lists');
  await expect(page.locator('.carocrm-doc-prose h2')).not.toHaveCount(0);
  await expect(page.locator('.carocrm-doc-toc a')).not.toHaveCount(0);

  // A handbook that cannot tell you where it came from is a wiki. §5.5 puts the route on the page.
  await page.getByRole('button', { name: 'Open this screen' }).click();
  await expect(page).toHaveURL(/\/Contact/);
});

test('3. a Vietnamese query without diacritics finds a page and highlights it', async ({ page }) => {
  await login(page);
  await page.goto('/docs');
  await page.getByLabel('Search the documentation').fill('cau hinh');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/docs\/search\?q=cau\+hinh|\/docs\/search\?q=cau%20hinh/);
  // §5.9: the answer, not the field, holds focus after a submit.
  await expect(page.locator('.carocrm-doc-results-head')).toBeFocused();
  await expect(page.locator('.carocrm-doc-result').first()).toBeVisible();
  await expect(page.locator('.carocrm-doc-result mark').first()).toBeVisible();
});

test('4. a CRM user sees no administrator page anywhere, and is refused at a direct URL', async ({ page }) => {
  await login(page, READER.userName, READER.password);

  await page.goto('/docs');
  await expect(page.locator('.carocrm-doc-door-title', { hasText: 'Administrator handbook' })).toHaveCount(0);
  await expect(page.locator('.carocrm-doc-door-title', { hasText: 'CRM user guide' })).toBeVisible();

  // The tree itself carries no administrator section, so the rail cannot disagree with the ACL (§10.2).
  const tree = await (await page.request.get('/api/v1/Docs/tree')).json();
  expect((tree.sections as { key: string }[]).map((section) => section.key)).not.toContain('admin');

  // The page exists; this reader simply may not read it. That is a refusal, not a 404.
  await page.goto('/docs/admin/main-menu');
  await expect(page.getByText('This page documents an administrator screen')).toBeVisible();

  // Search is scoped the same way: an administrator-only term answers with nothing.
  await page.goto('/docs/search?q=argon2id');
  await expect(page.locator('.carocrm-doc-result')).toHaveCount(0);
});

test('5. a deep link scrolls to the heading and moves focus to it', async ({ page }) => {
  await login(page);
  await page.goto('/docs/user/lists-and-views#save-a-filter');
  await expect(page).toHaveURL(/#save-a-filter$/);

  const heading = page.locator('h2#save-a-filter');
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  // Scrolled into view, not merely present somewhere below the fold. The scroll is animated, so wait for
  // it to arrive rather than reading a position mid-flight.
  await expect
    .poll(async () => (await heading.boundingBox())?.y ?? Number.POSITIVE_INFINITY, { timeout: 5_000 })
    .toBeLessThan(200);
});
