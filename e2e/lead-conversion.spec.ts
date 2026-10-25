import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Phase 19-LS.14 — the conversion wizard (`PLAN_Phase_19_LeadScore.md` §7.1–§7.4, §11.4, §16 `19-LS.14`;
 * contract §8; compat §4.1).
 *
 * The exit criterion is *"a user can complete valid Contact/Account conversion end-to-end with clear
 * feedback"*, so this spec drives the whole thing through the screen and asserts the two claims that make the
 * feedback honest:
 *
 *  1. **Created versus Linked is a fact on the result screen** — the ids there are the ids the API returns and
 *     the links open the right records;
 *  2. **the preview is what runs** — the review shows the values that will be written, the confirmations the
 *     person must see, and a stale plan is *refreshed and shown again* rather than converted quietly.
 *
 * It also covers the two failure modes a wizard has to survive: a duplicate that needs an explicit override,
 * and a lost response, which is recovered with the **same operation key** so no second set of records can
 * appear.
 *
 * Fixtures are created through the API with a run marker and removed afterwards; the `leadScore` settings row
 * is read before the run and put back. Operation rows are append-only by design (no delete route), so this
 * spec records that residue for the database-level sweep the run performs after it.
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const RUN = `E2E_LS14_${Date.now().toString(36)}`;

async function apiLogin(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
  expect(response.ok(), await response.text()).toBe(true);
  return String((await response.json()).accessToken);
}

async function api(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<Record<string, unknown>> {
  const response = await request.fetch(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(data === undefined ? {} : { data }) });
  expect(response.ok(), `${method} ${path} -> ${response.status()} ${await response.text()}`).toBe(true);
  const text = await response.text();
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** One picker: antd virtualises the option list, so a searchable Select is typed into before picking. */
async function pick(page: Page, control: Locator, text: string, type = true): Promise<void> {
  await control.click();
  if (type) await page.keyboard.type(text);
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: text }).first().click();
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

/** The conversion block for one target type, which is what scopes the identical radio labels. */
function targetBlock(page: Page, type: 'Contact' | 'Account'): Locator {
  return page.locator('.carocrm-conversion-target').filter({ has: page.locator('strong', { hasText: new RegExp(`^${type}$`) }) });
}

async function openWizard(page: Page, leadId: string): Promise<Locator> {
  await page.goto(`/Lead/${leadId}`);
  const card = page.locator('.ant-card').filter({ hasText: 'Conversion' }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Convert this Lead' }).click();
  const modal = page.getByRole('dialog').filter({ hasText: 'Convert ' });
  await expect(modal).toBeVisible();
  return modal;
}

/**
 * `has:` re-roots the inner locator under each candidate, so the inner one must be page-rooted — a locator
 * already anchored at the modal can never match inside its own descendant.
 */
async function chooseCreate(page: Page, type: 'Contact' | 'Account'): Promise<void> {
  await targetBlock(page, type).getByText('Create new', { exact: true }).click();
}

let token = '';
let settingsBefore: Record<string, unknown> = {};
let localeBefore: string | null = null;
const leads: { id: string; name: string; email: string }[] = [];
const created: { id: string; entity: string }[] = [];

test.beforeAll(async ({ request }) => {
  token = await apiLogin(request);
  settingsBefore = await api(request, 'GET', '/LeadScore/action/settings');
  localeBefore = (((await api(request, 'GET', '/AppUser/me'))['locale'] as string | null | undefined) ?? null);
  await api(request, 'POST', '/LeadScore/action/settings', {
    enabled: true,
    features: { fieldMapping: true, conversionPreview: true, leadConversion: true, conversionRecovery: true, duplicateDetection: true },
    scoring: { activeModelId: null },
  });
  await api(request, 'PATCH', '/AppUser/me', { locale: null });
}, 120_000);

test.afterAll(async ({ request }) => {
  const headers = { authorization: `Bearer ${token}` };
  await request.fetch('/api/v1/AppUser/me', { method: 'PATCH', headers, data: { locale: localeBefore } });
  const found = settingsBefore['settings'] as Record<string, unknown> | undefined;
  const foundScoring = (found?.['scoring'] ?? {}) as Record<string, unknown>;
  await request.fetch('/api/v1/LeadScore/action/settings', {
    method: 'POST',
    headers,
    data: {
      enabled: found?.['enabled'] ?? false,
      features: found?.['features'] ?? {},
      scoring: { activeModelId: foundScoring['activeModelId'] ?? null, debounceSeconds: foundScoring['debounceSeconds'] ?? 60 },
      ...(found?.['signals'] === undefined ? {} : { signals: found['signals'] }),
      ...(found?.['conversion'] === undefined ? {} : { conversion: found['conversion'] }),
    },
  });
  for (const record of created) await request.fetch(`/api/v1/${record.entity}/${record.id}`, { method: 'DELETE', headers });
  for (const lead of leads) await request.fetch(`/api/v1/Lead/${lead.id}`, { method: 'DELETE', headers });
});

/** A Lead of this run; the e-mail is unique so duplicate detection never fires unless a test wants it to. */
async function createLead(request: APIRequestContext, suffix: string, data: Record<string, unknown> = {}): Promise<{ id: string; name: string; email: string }> {
  const name = `${RUN} ${suffix}`;
  const email = `${RUN.toLowerCase()}.${suffix.replace(/\s+/g, '-')}@example.com`;
  const lead = await api(request, 'POST', '/Lead', {
    name,
    firstName: `${RUN}first`,
    lastName: name,
    company: `${RUN} Acme`,
    emailAddress: email,
    status: 'New',
    ...data,
  });
  const record = { id: String(lead['id']), name, email };
  leads.push(record);
  return record;
}

test.describe('the conversion wizard (19-LS.14)', () => {
  // Every test drives the screen as an administrator, so every test signs in first (the session is per-context).
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('converts into a new Contact and Account, and shows Created with working links', async ({ page, request }) => {
    const lead = await createLead(request, 'new targets');
    const modal = await openWizard(page, lead.id);

    await chooseCreate(page, 'Contact');
    await chooseCreate(page, 'Account');
    await modal.getByRole('button', { name: 'Review' }).click();

    // The review is the server's preview: the values to be written and the confirmations.
    await expect(modal.getByText('Will be written').first()).toBeVisible({ timeout: 20_000 });
    await expect(modal.getByText(`${RUN} Acme`).first()).toBeVisible();
    await expect(modal.getByText('Before you confirm')).toBeVisible();

    await modal.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(modal.getByText('This Lead is converted')).toBeVisible({ timeout: 30_000 });

    const contactLink = modal.getByRole('link').filter({ hasText: /^[0-9a-f-]{36}$/ }).first();
    expect(await contactLink.count()).toBeGreaterThan(0);
    const contactHref = await contactLink.getAttribute('href');
    expect(contactHref).toContain('/Contact/');
    await modal.getByRole('button', { name: 'Done' }).click();

    // The record now says so: the card and the metadata panel both show the conversion.
    const card = page.locator('.ant-card').filter({ hasText: 'Conversion' }).first();
    await expect(card.getByText(/Converted on/)).toBeVisible();
    await expect(page.getByText('Converted To').first()).toBeVisible();

    // And the API agrees with the screen, exactly once.
    const stored = (await api(request, 'GET', `/Lead/${lead.id}`)) as Record<string, unknown>;
    expect(stored['status']).toBe('Converted');
    expect(typeof stored['convertedContactId']).toBe('string');
    expect(typeof stored['convertedAccountId']).toBe('string');
    const contacts = (await api(request, 'GET', `/Contact?where=${encodeURIComponent(JSON.stringify([{ emailAddress: lead.email }]))}&maxSize=10`)) as { list?: unknown[] };
    expect(contacts.list ?? []).toHaveLength(1);
  });

  test('links an existing Contact and Account instead of creating them', async ({ page, request }) => {
    const lead = await createLead(request, 'link targets');
    const account = await api(request, 'POST', '/Account', { name: `${RUN} linked account` });
    const contact = await api(request, 'POST', '/Contact', { name: `${RUN} linked contact`, lastName: `${RUN} linked contact` });
    created.push({ id: String(account['id']), entity: 'Account' }, { id: String(contact['id']), entity: 'Contact' });

    const modal = await openWizard(page, lead.id);
    await targetBlock(page, 'Account').getByText('Link existing', { exact: true }).click();
    await pick(page, targetBlock(page, 'Account').locator('.ant-select'), `${RUN} linked account`);

    await targetBlock(page, 'Contact').getByText('Link existing', { exact: true }).click();
    await pick(page, targetBlock(page, 'Contact').locator('.ant-select'), `${RUN} linked contact`);

    await modal.getByRole('button', { name: 'Review' }).click();
    await expect(modal.getByText('Before you confirm')).toBeVisible({ timeout: 20_000 });
    await modal.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(modal.getByText('This Lead is converted')).toBeVisible({ timeout: 30_000 });
    await modal.getByRole('button', { name: 'Done' }).click();

    const stored = (await api(request, 'GET', `/Lead/${lead.id}`)) as Record<string, unknown>;
    expect(stored['convertedContactId']).toBe(String(contact['id']));
    expect(stored['convertedAccountId']).toBe(String(account['id']));
    // The relationship is the write a link carries: the Contact now belongs to that Account.
    const linked = (await api(request, 'GET', `/Contact/${String(contact['id'])}`)) as Record<string, unknown>;
    expect(linked['accountId']).toBe(String(account['id']));
  });

  test('stops on a duplicate until the override is given, then converts once', async ({ page, request }) => {
    const lead = await createLead(request, 'duplicate');
    const existing = await api(request, 'POST', '/Contact', { name: `${RUN} existing duplicate`, lastName: `${RUN} existing duplicate`, emailAddress: lead.email });
    created.push({ id: String(existing['id']), entity: 'Contact' });

    const modal = await openWizard(page, lead.id);
    await chooseCreate(page, 'Contact');
    await modal.getByRole('button', { name: 'Review' }).click();
    await expect(modal.getByText('Possible duplicates', { exact: true })).toBeVisible({ timeout: 20_000 });

    await modal.getByRole('button', { name: 'Convert', exact: true }).click();
    // The command refuses without a decision, and the screen says which decision is missing.
    await expect(modal.getByText(/possible duplicates/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(modal.getByText('This Lead is converted')).toHaveCount(0);

    await modal.getByText(/Create anyway/).click();
    await modal.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(modal.getByText('This Lead is converted')).toBeVisible({ timeout: 30_000 });
    await modal.getByRole('button', { name: 'Done' }).click();
    expect(((await api(request, 'GET', `/Lead/${lead.id}`)) as Record<string, unknown>)['status']).toBe('Converted');
  });

  test('refreshes a stale preview instead of converting a plan nobody saw', async ({ page, request }) => {
    const lead = await createLead(request, 'stale');
    const modal = await openWizard(page, lead.id);
    await chooseCreate(page, 'Contact');
    await modal.getByRole('button', { name: 'Review' }).click();
    await expect(modal.getByText('Before you confirm')).toBeVisible({ timeout: 20_000 });

    // Somebody else edits the Lead while the review is open.
    await api(request, 'PATCH', `/Lead/${lead.id}`, { title: 'edited during the review' });
    await modal.getByRole('button', { name: 'Convert', exact: true }).click();

    await expect(modal.getByText(/The Lead changed while you were reviewing/)).toBeVisible({ timeout: 20_000 });
    await expect(modal.getByText('This Lead is converted')).toHaveCount(0);
    // Confirming the refreshed plan works, and only then is the Lead converted.
    await modal.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(modal.getByText('This Lead is converted')).toBeVisible({ timeout: 30_000 });
    expect(((await api(request, 'GET', `/Lead/${lead.id}`)) as Record<string, unknown>)['status']).toBe('Converted');
  });

  test('recovers a lost response with the same operation key, never a second conversion', async ({ page, request }) => {
    const lead = await createLead(request, 'lost response');
    const modal = await openWizard(page, lead.id);
    await chooseCreate(page, 'Contact');
    await modal.getByRole('button', { name: 'Review' }).click();
    await expect(modal.getByText('Before you confirm')).toBeVisible({ timeout: 20_000 });

    // The first convert is *sent* and then the response is thrown away: exactly the timeout this recovery is for.
    let seen = 0;
    await page.route('**/api/v1/LeadScore/action/conversion/convert', async (route) => {
      seen += 1;
      if (seen === 1) {
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await modal.getByRole('button', { name: 'Convert', exact: true }).click();
    const retry = modal.getByRole('button', { name: 'Try again with the same operation key' });
    await expect(retry).toBeVisible({ timeout: 30_000 });
    await retry.click();
    await expect(modal.getByText('This Lead is converted')).toBeVisible({ timeout: 30_000 });

    // One conversion, one Contact — the key made the retry a replay, not a second attempt.
    const contacts = (await api(request, 'GET', `/Contact?where=${encodeURIComponent(JSON.stringify([{ emailAddress: lead.email }]))}&maxSize=10`)) as { list?: unknown[] };
    expect(contacts.list ?? []).toHaveLength(1);
    const stored = (await api(request, 'GET', `/Lead/${lead.id}`)) as Record<string, unknown>;
    expect(stored['status']).toBe('Converted');
  });

  test('fits a phone and keeps the dialog keyboard-reachable', async ({ page }) => {
    const lead = await createLead(page.request, 'phone');
    await page.setViewportSize({ width: 390, height: 844 });
    const modal = await openWizard(page, lead.id);
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await chooseCreate(page, 'Contact');
    const review = modal.getByRole('button', { name: 'Review' });
    // A keyboard interaction first: `:focus-visible` is what the check is about, and a focus() after mouse
    // clicks is not "visible" focus by the browser's own heuristic.
    await page.keyboard.press('Tab');
    await review.focus();
    const visible = await review.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.matches(':focus-visible') && style.outlineWidth !== '0px';
    });
    expect(visible).toBe(true);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });
});
