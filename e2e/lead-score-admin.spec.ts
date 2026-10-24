import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Phase 19-LS.8 — the scoring model workspace
 * (`PLAN_Phase_19_LeadScore.md` §6.1, §9.4, §16 `19-LS.8`; audit §11).
 *
 * The exit criterion is one sentence: *an admin can manage a deterministic model without editing raw JSON
 * manually or running code.* So this spec does the whole job through the form and the commands, and asserts
 * the two things that make the claim honest:
 *
 *  1. a rule's condition is **produced** by the builder — the test never types a brace, and what the form
 *     stored is read back off the rule row as words;
 *  2. a **preview writes nothing**: the fixture Leads carry no score before the run and still carry none
 *     afterwards, which is the audit row's check that a preview cannot become a back-door recalculation.
 *
 * The lifecycle is exercised too — validate, publish, the freeze that publishing causes, a new version and
 * its comparison — and the surface is held to 390px and to a keyboard, as every other Phase 19 page is.
 *
 * Fixtures are created through the API with a run marker and removed afterwards; the `leadScore` settings row
 * is read before the run and put back, because an e2e run must not leave Lead Score armed against the
 * development database.
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const RUN = `E2E_LS8_${Date.now().toString(36)}`;
const MODEL_NAME = `${RUN} model`;
/** Two of the three carry a company, which is the signal the drafted rule reads. */
const COMPANIES: readonly (string | null)[] = ['Playwright Industries', null, 'Playwright Ltd'];

async function apiLogin(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
  expect(response.ok(), await response.text()).toBe(true);
  return String((await response.json()).accessToken);
}

async function api(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<Record<string, unknown>> {
  const response = await request.fetch(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(data === undefined ? {} : { data }) });
  expect(response.ok(), `${method} ${path} -> ${response.status()} ${await response.text()}`).toBe(true);
  const text = await response.text();
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** The model rows this run owns, newest last. */
async function readModels(request: APIRequestContext): Promise<{ id: string; status: string; modelVersion: number }[]> {
  const where = encodeURIComponent(JSON.stringify([{ name: MODEL_NAME }]));
  const list = (await api(request, 'GET', `/LeadScoreModel?where=${where}&orderBy=modelVersion&maxSize=20`)) as { list?: { id: string; status: string; modelVersion: number }[] };
  return list.list ?? [];
}

/** The stored projection of one Lead, which a preview must leave untouched. */
async function readScoreValue(request: APIRequestContext, leadId: string): Promise<number | null> {
  const response = await request.fetch(`/api/v1/Lead/${leadId}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.ok(), await response.text()).toBe(true);
  const value = ((await response.json()) as Record<string, unknown>)['scoreValue'];
  return typeof value === 'number' ? value : null;
}

/**
 * antd renders a Select's options in a portal and virtualises the list, so a searchable picker is typed into
 * before picking. A short list (the operators of one field type) is picked straight from the panel.
 */
async function pick(page: Page, control: Locator, text: string, type = true): Promise<void> {
  await control.click();
  if (type) await page.keyboard.type(text);
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: text })
    .first()
    .click();
}

/** One band row of the model form: its picker and its two range inputs. */
function bandRow(scope: Locator, index: number): Locator {
  return scope.locator('.carocrm-band-row').nth(index);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

let token = '';
let settingsBefore: Record<string, unknown> = {};
let localeBefore: string | null = null;
const leads: { id: string; name: string }[] = [];
let modelId = '';

test.beforeAll(async ({ request }) => {
  token = await apiLogin(request);
  settingsBefore = await api(request, 'GET', '/LeadScore/action/settings');
  localeBefore = (((await api(request, 'GET', '/AppUser/me'))['locale'] as string | null | undefined) ?? null);
  // The module and the two features this workspace drives, on before the UI touches them: the gate refuses a
  // command whose switch is off, which is the point of the gate rather than an obstacle here.
  await api(request, 'POST', '/LeadScore/action/settings', {
    enabled: true,
    features: { modelAdministration: true, scoringPreview: true, scoring: true, manualRecalculation: true, scoreExplanation: true },
    scoring: { activeModelId: null },
  });
  // Labels are asserted in English, so the reader's own preference is pinned for the run and put back.
  await api(request, 'PATCH', '/AppUser/me', { locale: null });

  for (const [index, company] of COMPANIES.entries()) {
    const name = `${RUN} lead ${String(index)}`;
    const lead = await api(request, 'POST', '/Lead', {
      name,
      lastName: name,
      firstName: 'Probe',
      ...(company === null ? {} : { company }),
      status: 'New',
    });
    leads.push({ id: String(lead['id']), name });
  }
});

test.afterAll(async ({ request }) => {
  const headers = { authorization: `Bearer ${token}` };
  await request.fetch('/api/v1/AppUser/me', { method: 'PATCH', headers, data: { locale: localeBefore } });
  const debounce = ((settingsBefore['settings'] as Record<string, unknown> | undefined)?.['scoring'] as Record<string, unknown> | undefined)?.['debounceSeconds'];
  await request.fetch('/api/v1/LeadScore/action/settings', {
    method: 'POST',
    headers,
    data: { enabled: false, scoring: { activeModelId: null, debounceSeconds: typeof debounce === 'number' ? debounce : 60 } },
  });

  for (const model of await readModels(request)) {
    // Rules first: the LS.2 guard refuses an edit or delete of a frozen version's rules through the record
    // API, so this is also a check that a published version really is the thing the guard protects.
    const rules = await request.fetch(`/api/v1/LeadScoreRule?where=${encodeURIComponent(JSON.stringify([{ modelId: model.id }]))}`, { headers });
    if (rules.ok()) {
      const list = ((await rules.json()) as { list?: { id: string }[] }).list ?? [];
      for (const rule of list) await request.fetch(`/api/v1/LeadScoreRule/${rule.id}`, { method: 'DELETE', headers });
    }
    await request.fetch(`/api/v1/LeadScoreModel/${model.id}`, { method: 'DELETE', headers });
  }
  for (const lead of leads) await request.fetch(`/api/v1/Lead/${lead.id}`, { method: 'DELETE', headers });
});

test.describe('the scoring model workspace (19-LS.8)', () => {
  test('an administrator drafts, validates and publishes a model without typing JSON', async ({ page }) => {
    await login(page);
    await page.goto('/lead-score');
    await expect(page.getByRole('heading', { name: 'Lead Score' })).toBeVisible();

    await page.getByRole('button', { name: 'New model' }).click();
    const modal = page.getByRole('dialog').filter({ hasText: 'New scoring model' });
    await expect(modal).toBeVisible();
    await modal.getByLabel('Name').fill(MODEL_NAME);
    await modal.getByLabel('Base score').fill('20');
    await modal.getByLabel('Ceiling').fill('100');

    // The bands are rows: a name from the module's vocabulary and a whole-number range.
    // A band is a row: a name from the module's vocabulary and a whole-number range. Scoped per row,
    // because antd puts the accessible name on the inner input as well as the selector.
    await modal.getByRole('button', { name: 'Add band' }).click();
    await pick(page, bandRow(modal, 0).locator('.ant-select'), 'Cold');
    await bandRow(modal, 0).getByLabel('To').fill('39');
    await modal.getByRole('button', { name: 'Add band' }).click();
    await pick(page, bandRow(modal, 1).locator('.ant-select'), 'Hot');
    await bandRow(modal, 1).getByLabel('From').fill('40');
    await bandRow(modal, 1).getByLabel('To').fill('100');

    await modal.getByRole('button', { name: 'Save' }).click();
    await expect(modal).toHaveCount(0);

    const row = page.getByRole('row').filter({ hasText: MODEL_NAME });
    await expect(row).toBeVisible();
    await expect(row.locator('.carocrm-pill', { hasText: 'draft' })).toBeVisible();

    // Creating a draft opens it for editing: the administrator lands on the work, not on the list.
    const card = page.locator('.carocrm-model-detail');
    await expect(card).toBeVisible();
    // A model with no rule is a decision with no reason. The validator *warns* about it in its own words:
    // it is a modelling smell, not a refusal, and the form shows the sentence rather than hiding it.
    await card.getByRole('button', { name: 'Validate' }).click();
    await expect(card.getByText('This model has no enabled rule')).toBeVisible({ timeout: 20_000 });

    // ---- the rule, built entirely from the catalog the server offered -------------------------------
    await card.getByRole('button', { name: 'Add rule' }).click();
    const ruleModal = page.getByRole('dialog').filter({ hasText: 'New rule' });
    await expect(ruleModal).toBeVisible();
    await ruleModal.getByLabel('Name').fill(`${RUN} company rule`);
    await ruleModal.getByLabel('Reason code').fill(`e2e_ls8_company_${RUN.slice(-6).toLowerCase()}`);
    await ruleModal.getByLabel('Points').fill('15');

    await ruleModal.getByRole('button', { name: 'Add condition' }).click();
    const leaf = ruleModal.locator('.carocrm-condition-leaf').first();
    await pick(page, leaf.locator('.ant-select').first(), 'Company');
    await pick(page, leaf.locator('.ant-select').nth(1), 'is not empty');
    // An existence operator takes no value, and the form says so instead of showing a blank input.
    await expect(leaf.getByText('no value')).toBeVisible();

    await ruleModal.getByRole('button', { name: 'Save' }).click();
    await expect(ruleModal).toHaveCount(0);
    // The rule row reads as a sentence the server's metadata produced, not as a JSON blob.
    await expect(card.getByText('Company is not empty')).toBeVisible();

    await card.getByRole('button', { name: 'Validate' }).click();
    await expect(card.getByText('The model is valid.')).toBeVisible({ timeout: 20_000 });

    // ---- publish: the one action that freezes a version ---------------------------------------------
    await card.getByRole('button', { name: 'Publish' }).click();
    const confirm = page.locator('.ant-modal-confirm').filter({ hasText: 'as an immutable version?' });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText('a score is read from this version')).toBeVisible();
    await confirm.getByRole('button', { name: 'Publish' }).click();

    await expect(page.getByRole('row').filter({ hasText: MODEL_NAME }).locator('.carocrm-pill', { hasText: 'published' })).toBeVisible({ timeout: 20_000 });
    const published = (await readModels(page.request)).find((entry) => entry.modelVersion === 1);
    expect(published?.id).toBeTruthy();
    modelId = String(published?.id ?? '');

    // A frozen version says so, and offers the way forward rather than an editor.
    const detail = page.locator('.carocrm-model-detail');
    await expect(detail.getByText('This version is immutable.')).toBeVisible();
    await expect(detail.getByRole('button', { name: 'New version' })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  });

  test('a preview scores a sample and changes nothing', async ({ page }) => {
    test.skip(modelId === '', 'the published model was not created by the first test');
    const before = await Promise.all(leads.map((lead) => readScoreValue(page.request, lead.id)));

    await login(page);
    await page.goto('/lead-score?tab=preview');
    const panel = page.locator('.ant-card').filter({ hasText: 'Preview a model' }).first();
    await expect(panel).toBeVisible();

    await pick(page, panel.locator('.ant-select').first(), MODEL_NAME);
    await panel.getByText('Choose Leads').click();
    const picker = panel.locator('.ant-select').nth(1);
    for (const lead of leads) await pick(page, picker, lead.name);
    await panel.getByRole('button', { name: 'Run preview' }).click();

    await expect(panel.getByText('Nothing was written.')).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText('writes: false')).toBeVisible();
    // The two Leads with a company answer 20 + 15; the third stops at the base score.
    await expect(panel.getByRole('cell', { name: '35', exact: true })).toHaveCount(2);
    await expect(panel.getByRole('cell', { name: '20', exact: true })).toHaveCount(1);

    const after = await Promise.all(leads.map((lead) => readScoreValue(page.request, lead.id)));
    // Plan §6.1 and the audit's LS.8 row: a preview must not move a stored score. Nothing was stored before
    // and nothing is stored after — a preview is not a recalculation wearing a debugger's clothes.
    expect(after).toEqual(before);
    expect(after.every((value) => value === null)).toBe(true);
  });

  test('a new version can be compared with the version it came from', async ({ page }) => {
    test.skip(modelId === '', 'the published model was not created by the first test');
    await login(page);
    await page.goto('/lead-score');
    await page.getByRole('row').filter({ hasText: MODEL_NAME }).first().click();
    const card = page.locator('.carocrm-model-detail');
    await card.getByRole('button', { name: 'New version' }).click();
    await expect(page.getByRole('row').filter({ hasText: MODEL_NAME })).toHaveCount(2, { timeout: 20_000 });

    await page.getByRole('row').filter({ hasText: MODEL_NAME }).nth(1).click();
    const detail = page.locator('.carocrm-model-detail');
    await detail.getByRole('button', { name: 'Compare versions' }).click();
    const diff = page.getByRole('dialog').filter({ hasText: 'Compare versions' });
    await expect(diff).toBeVisible();
    await expect(diff.locator('.carocrm-diff-side').first()).toContainText('v1');
    await expect(diff.locator('.carocrm-diff-side').nth(1)).toContainText('v2');
    // A copy differs from its source in one thing only: the state it is in — marked on both sides.
    await expect(diff.locator('.carocrm-diff-field--changed')).toHaveCount(2);
    await expect(diff.locator('.carocrm-diff-field--changed').first()).toContainText('State');
    // The rule set came along unchanged, which is what makes the new draft worth publishing forward.
    await expect(diff.getByText('Every rule of this reason code is identical')).toBeVisible({ timeout: 20_000 });
    await diff.getByRole('button', { name: 'Close' }).click();
  });

  test('the workspace fits a phone and a keyboard', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto('/lead-score');
    await expect(page.getByRole('button', { name: 'New model' })).toBeVisible();
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 1440, height: 900 });
    const button = page.getByRole('button', { name: 'New model' });
    await button.focus();
    const visible = await button.evaluate((el) => {
      const style = getComputedStyle(el);
      return el.matches(':focus-visible') && style.outlineWidth !== '0px';
    });
    expect(visible).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog').filter({ hasText: 'New scoring model' })).toBeVisible();
  });
});
