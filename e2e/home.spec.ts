import { expect, type Page, test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

/**
 * The home workspace (`PLAN_Phase_20_Settings_UX.md` §20.19).
 *
 * The regression this guards is the page `/home` used to be: one stat tile per enabled entity, each
 * fed by `GET /{Entity}?maxSize=1`. So the test asserts both halves — the workspace renders, and no
 * per-entity count request exists, whatever this instance has enabled.
 */
test.describe('home workspace', () => {
  test('renders the workspace and issues no per-entity count request', async ({ page }) => {
    const requests: string[] = [];
    const consoleErrors: string[] = [];
    const failedResponses: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/')) requests.push(request.url());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) failedResponses.push(`${String(response.status())} ${response.url()}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await login(page);
    await expect(page.locator('.carocrm-home')).toBeVisible();

    // A fresh signed-in load is what the budget is measured on. The log is cleared here so the
    // sign-in screen's `Refresh` probe — which runs before this user has a session — is not counted.
    requests.length = 0;
    consoleErrors.length = 0;
    failedResponses.length = 0;
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.carocrm-home-focus-strip')).toBeVisible();
    // The dev server keeps its HMR socket open, so `networkidle` never settles; wait for the cards
    // themselves to finish instead of for the socket.
    await expect(page.locator('.carocrm-home .carocrm-home-skeleton')).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(400);

    // The old page: a tile per entity, each one a `maxSize=1` list call. The only `maxSize=1` the
    // shell may still issue is the header's unread-notification badge, which is not an entity count.
    const entityCountCalls = requests.filter(
      (url) => /[?&]maxSize=1(&|$)/.test(url) && !new URL(url).pathname.endsWith('/Notification'),
    );
    expect(entityCountCalls).toEqual([]);
    await expect(page.locator('.carocrm-stat-icon')).toHaveCount(0);

    // One request per home card, and at most three KPI dashlet runs behind the pulse rail — the
    // count does not scale with the number of entities this instance enables.
    const count = (fragment: string): number => requests.filter((url) => url.includes(fragment)).length;
    expect(count('/ProcessTask')).toBe(1);
    expect(count('/ProcessInstance')).toBe(1);
    expect(count('/Calendar')).toBe(1);
    expect(count('/Stream')).toBe(1);
    expect(count('/Dashboard')).toBeLessThanOrEqual(4);

    expect(failedResponses).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test('hero search, the create menu and the focus cards lead where they say', async ({ page }) => {
    await login(page);
    await expect(page.locator('.carocrm-home')).toBeVisible();

    // Search: Enter on the hero input opens the results page with the term.
    const term = `home-${Date.now().toString(36)}`;
    await page.locator('.carocrm-home-search input').fill(term);
    await page.locator('.carocrm-home-search input').press('Enter');
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${term}`), { timeout: 20_000 });
    await page.goBack();

    // Create: the menu lists the navigable entities and opens a new-record form.
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const firstEntity = page.locator('.carocrm-home-create-menu .ant-dropdown-menu-item').first();
    await expect(firstEntity).toBeVisible({ timeout: 10_000 });
    await firstEntity.click();
    await expect(page).toHaveURL(/\/create$/, { timeout: 20_000 });

    // The tasks card is one link to the task surface.
    await page.goto('/home');
    await page.locator('a.carocrm-home-focus-card').first().click();
    await expect(page).toHaveURL(/\/tasks/, { timeout: 20_000 });
  });

  test('has no horizontal overflow at 1440, 1180, 768 and 390 px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await expect(page.locator('.carocrm-home')).toBeVisible();
    await expect(page.locator('.carocrm-home .carocrm-home-skeleton')).toHaveCount(0, { timeout: 20_000 });

    /** Column count of a CSS grid, read from the resolved template. */
    const columnsAt = async (width: number): Promise<{ focus: number; body: number }> => {
      await page.setViewportSize({ width, height: 900 });
      return page.evaluate(() => {
        const columns = (selector: string): number => {
          const node = document.querySelector(selector);
          if (!node) return 0;
          return getComputedStyle(node).gridTemplateColumns.split(' ').filter((part) => part !== '').length;
        };
        return { focus: columns('.carocrm-home-focus-strip'), body: columns('.carocrm-home-body') };
      });
    };

    // Resizing re-runs the shell's responsive state, so the measurement is polled until the layout
    // settles instead of reading a mid-transition width.
    for (const width of [1440, 1180, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(
          async () =>
            page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
          { message: `horizontal overflow at ${String(width)} px` },
        )
        .toBeLessThanOrEqual(0);
    }

    // The design rules: three focus cards across while they fit, one body column below 1180 px.
    expect(await columnsAt(1440)).toEqual({ focus: 3, body: 2 });
    expect(await columnsAt(1180)).toEqual({ focus: 3, body: 1 });
    expect(await columnsAt(768)).toEqual({ focus: 3, body: 1 });
    expect(await columnsAt(390)).toEqual({ focus: 1, body: 1 });
  });
});
