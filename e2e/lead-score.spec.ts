import { type APIRequestContext, expect, type Page,test } from '@playwright/test';

/**
 * Phase 19-LS.7 — the Lead Score surface (PLAN_Phase_19_LeadScore.md §11.1, §12, §16 `19-LS.7`;
 * report `docs/implementation/lead-score-ls7-completion-report.md`).
 *
 * The plan's exit criterion is a sentence about the boundary, not about pixels: *the UI uses API data and
 * never bypasses field/record ACL.* So this spec checks the three things a screenshot cannot prove:
 *
 * 1. the list carries the stored projection — a column and a filter that read `scoreValue`/`scoreBand` off
 *    the record, which is plan §4.2's rule that no list read computes a score;
 * 2. the detail card shows the number, the band, the freshness verdict and the rule-by-rule reason the
 *    **server** produced, and the Recalculate button is there because the server's `actions` answer said so;
 * 3. the surface holds at 390px and under a keyboard, and a band is never carried by colour alone.
 *
 * It creates its own model, rules and Lead through the API and removes them afterwards. The administrator's
 * locale preference is pinned for the run and put back, because the platform rule "the reader's own
 * preference wins" would otherwise make every label assertion depend on what someone did in this database
 * yesterday.
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const RUN = `E2E_LS7_${Date.now().toString(36)}`;

async function apiLogin(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
  expect(response.ok(), await response.text()).toBe(true);
  return String((await response.json()).accessToken);
}

async function api(request: APIRequestContext, token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, data?: unknown) {
  const response = await request.fetch(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method} ${path} -> ${response.status()} ${await response.text()}`).toBe(true);
  const text = await response.text();
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

interface Fixture {
  readonly modelId: string;
  readonly leadId: string;
  readonly ruleName: string;
}

/** A published model with one completeness rule, one active Lead, and a score that was actually stored. */
async function createScoredLead(request: APIRequestContext, token: string): Promise<Fixture> {
  const model = await api(request, token, 'POST', '/LeadScoreModel', {
    name: `${RUN} model`,
    description: 'Created by the LS.7 browser spec.',
    modelVersion: 1,
    scaleMin: 0,
    scaleMax: 100,
    baseScore: 20,
    scoreFloor: 0,
    scoreCeiling: 100,
    qualificationBands: JSON.stringify([
      { band: 'Cold', min: 0, max: 39 },
      { band: 'Warm', min: 40, max: 69 },
      { band: 'Hot', min: 70, max: 89 },
      { band: 'Sales Ready', min: 90, max: 100 },
    ]),
    allowedFieldPaths: JSON.stringify(['company', 'industry']),
  });
  const modelId = String(model['id']);
  const ruleName = `${RUN} company rule`;
  await api(request, token, 'POST', '/LeadScoreRule', {
    name: ruleName,
    modelId,
    modelVersion: 1,
    reasonCode: `e2e_ls7_company_${modelId.slice(-6)}`,
    dimension: 'completeness',
    enabled: true,
    condition: JSON.stringify({ field: 'company', operator: 'isNotEmpty' }),
    effect: 'add',
    points: 10,
    priority: 10,
    missingDataPolicy: 'neutral',
    signalSource: 'lead',
  });
  // Enable before publishing: `publish` is a module command and the gate refuses it while the switch is
  // off, which is the point of the gate rather than an obstacle here.
  await api(request, token, 'POST', '/LeadScore/action/settings', {
    enabled: true,
    features: { modelAdministration: true, scoring: true, manualRecalculation: true, scoreExplanation: true },
  });
  await api(request, token, 'POST', '/LeadScore/action/model/publish', { modelId });
  await api(request, token, 'POST', '/LeadScore/action/settings', { scoring: { activeModelId: modelId, debounceSeconds: 60 } });

  const lead = await api(request, token, 'POST', '/Lead', {
    name: `${RUN} lead`,
    lastName: `${RUN} lead`,
    company: 'Playwright Industries',
    status: 'New',
  });
  const leadId = String(lead['id']);
  await api(request, token, 'POST', '/LeadScore/action/score/recalculate', { leadId });
  return { modelId, leadId, ruleName };
}

async function dropFixture(request: APIRequestContext, token: string, fixture: Fixture): Promise<void> {
  const headers = { authorization: `Bearer ${token}` };
  // The module document first, and the whole thing: an e2e run must not leave Lead Score armed against the
  // development database, and a feature flag left behind is just as armed as the switch. `settingsBefore` is
  // the row as this run found it (see `beforeAll`).
  await request.fetch('/api/v1/LeadScore/action/settings', { method: 'POST', headers, data: settingsRestore });
  // Rules, then the model they belong to, then the Lead. The generic API soft-deletes, which is what every
  // other spec in this directory leaves behind; the run marker keeps them identifiable in the database.
  const rules = await request.fetch(`/api/v1/LeadScoreModel/${fixture.modelId}/rules`, { headers });
  if (rules.ok()) {
    const body = (await rules.json()) as { list?: { id: string }[] } | { id: string }[];
    const list = Array.isArray(body) ? body : (body.list ?? []);
    for (const rule of list) {
      await request.fetch(`/api/v1/LeadScoreRule/${rule.id}`, { method: 'DELETE', headers });
    }
  }
  await request.fetch(`/api/v1/LeadScoreModel/${fixture.modelId}`, { method: 'DELETE', headers });
  await request.fetch(`/api/v1/Lead/${fixture.leadId}`, { method: 'DELETE', headers });
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

let token = '';
let previousLocale: string | null = null;
let fixture: Fixture | undefined;
/** The settings document as this run found it, replayed verbatim on teardown. */
let settingsRestore: Record<string, unknown> = { enabled: false, features: {}, scoring: { activeModelId: null } };

test.beforeAll(async ({ request }) => {
  token = await apiLogin(request);
  const me = await api(request, token, 'GET', '/AppUser/me');
  previousLocale = (me['locale'] as string | null | undefined) ?? null;
  await api(request, token, 'PATCH', '/AppUser/me', { locale: null });
  const settings = await api(request, token, 'GET', '/LeadScore/action/settings');
  const found = (settings['settings'] ?? {}) as Record<string, unknown>;
  settingsRestore = {
    enabled: found['enabled'] ?? false,
    features: found['features'] ?? {},
    scoring: found['scoring'] ?? { activeModelId: null },
  };
  fixture = await createScoredLead(request, token);
});

test.afterAll(async ({ request }) => {
  if (fixture !== undefined) await dropFixture(request, token, fixture);
  await api(request, token, 'PATCH', '/AppUser/me', { locale: previousLocale });
});

test.describe('the Lead Score surface (19-LS.7)', () => {
  test('the Lead list carries the stored projection, as a column and as a filter', async ({ page }) => {
    await login(page);
    await page.goto('/Lead');
    await expect(page.getByRole('columnheader', { name: 'Score Value' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Score Band' })).toBeVisible();

    // The row's band is a word, not a colour: the pill's own text says "Cold" (the status pill is a second
    // pill in the same row, so the assertion names the one it means).
    const row = page.getByRole('row').filter({ hasText: `${RUN} lead` });
    await expect(row).toBeVisible();
    await expect(row.locator('.carocrm-pill', { hasText: 'Cold' })).toBeVisible();
    await expect(row).toContainText('30');

    // The filter panel shows five controls and discloses the rest; the score filters are among those.
    await page.getByRole('button', { name: /more filters/i }).click();
    await expect(page.locator('.carocrm-filter-label', { hasText: 'Score Value' })).toBeVisible();
    await expect(page.locator('.carocrm-filter-label', { hasText: 'Score Band' })).toBeVisible();
  });

  test('the Lead detail card explains the score with the server’s own words and action', async ({ page }) => {
    test.skip(fixture === undefined, 'the score fixture was not created');
    await login(page);
    await page.goto(`/Lead/${fixture?.leadId}`);

    const card = page.locator('.carocrm-card').filter({ hasText: 'Lead Score' }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText('Cold').first()).toBeVisible();
    await expect(card.getByText('30').first()).toBeVisible();
    // The reason list is the stored breakdown: rule name, dimension and outcome, never a Lead value.
    await expect(card.getByText('Why this score')).toBeVisible();
    await expect(card.getByText(fixture?.ruleName ?? '')).toBeVisible();
    await expect(card.getByText('Completeness · Applied')).toBeVisible();
    // Plan §9.2: an explanation that quoted the field would read past its ACL. The company value is the
    // rule's input, so it must not appear in the reason block.
    await expect(card.getByText('Playwright Industries')).toHaveCount(0);

    // The action is rendered because the server's `actions.recalculate` said this caller may run it.
    const recalculate = card.getByRole('button', { name: 'Recalculate' });
    await expect(recalculate).toBeVisible();
    await recalculate.click();
    await expect(page.locator('.ant-message')).toContainText(/recorded|unchanged/i);

    await card.getByRole('button', { name: 'History' }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Cold').first()).toBeVisible();
    await drawer.getByRole('button', { name: 'Close' }).click();
  });

  test('the card fits a phone and a keyboard, and focus is visible', async ({ page }) => {
    test.skip(fixture === undefined, 'the score fixture was not created');
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto(`/Lead/${fixture?.leadId}`);
    await expect(page.getByText('Lead Score').first()).toBeVisible();
    await noHorizontalOverflow(page);

    await page.setViewportSize({ width: 1440, height: 900 });
    const recalculate = page.getByRole('button', { name: 'Recalculate' });
    await recalculate.scrollIntoViewIfNeeded();
    await recalculate.focus();
    const visible = await recalculate.evaluate((el) => {
      const style = getComputedStyle(el);
      return el.matches(':focus-visible') && style.outlineWidth !== '0px';
    });
    expect(visible).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.locator('.ant-message')).toContainText(/recorded|unchanged/i);
  });
});
