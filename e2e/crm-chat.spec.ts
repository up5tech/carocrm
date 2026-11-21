import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Phase 19-CHAT / §15 / §17 — the CRM Chat workspace in the browser.
 *
 * What this spec pins down: the workspace renders for an administrator on a standard seed, the
 * diagnostics drawer opens and names the module, the settings dialog opens and is **cancelled**,
 * and the header's quick-chat panel opens without sending anything. No turn is submitted, no
 * conversation is created and no setting is saved — the shared development database keeps only
 * its seeded configuration (AGENTS.MD §3.3).
 *
 * The seeded environment has no published answering agent and `crmChat` flags at their defaults,
 * so nothing here can produce a model call: the composer's state depends on the environment, and
 * this spec deliberately asserts nothing about it.
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const runId = Date.now().toString(36);

/** Generated forms label their fields in human words; the tests address them by name. */
function labelFor(fieldName: string): string {
  const spaced = fieldName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldInput(page: Page, label: string): Locator {
  const text = labelFor(label);
  const item = page.locator('.ant-form-item').filter({ has: page.locator('label', { hasText: new RegExp(`^${text}$`) }) }).first();
  return item.locator('input, textarea').first();
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

test('the workspace renders and the settings dialog opens and is cancelled', async ({ page }) => {
  await login(page);

  await page.goto('/crm-chat');
  await expect(page.getByRole('heading', { name: 'CRM Chat' })).toBeVisible();
  await expect(page.getByRole('button', { name: /\bNew\b/ })).toBeVisible();

  // Diagnostics: names the module and its served facts, without leaking model internals.
  await page.getByRole('button', { name: 'Diagnostics' }).click();
  const diagnostics = page.getByRole('dialog').filter({ hasText: 'Delivered phases' });
  await expect(diagnostics).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(diagnostics).toBeHidden();

  // Settings: opens for an administrator; Cancel closes it and saves nothing.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog').filter({ hasText: 'CRM Chat settings' });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Cancel' }).click();
  await expect(settings).toBeHidden();
});

test('the quick-chat panel opens from the header without sending', async ({ page }) => {
  await login(page);

  await page.goto('/home');
  await page.getByRole('button', { name: 'Ask AI' }).click();
  await expect(page.getByText('Quick chat')).toBeVisible();
  await expect(page.getByText('Ask a question and the answer appears right here.')).toBeVisible();
  // Toggle it closed again; nothing was typed and nothing was sent.
  await page.getByRole('button', { name: 'Ask AI' }).click();
  await expect(page.getByText('Ask a question and the answer appears right here.')).toBeHidden();
});

/**
 * Phase 25.9 — the page context in the browser.
 *
 * The panel on a record page carries that record as the conversation's context, so "summarize this
 * company" means the company the user is looking at. What the browser may show is a chip; what the
 * model may read is decided by the server, under the caller's own ACL (the API suite proves that
 * half). Nothing here sends a turn: the seeded deployment has no published answering agent, so a
 * submission could not produce a model call anyway.
 */
test('the quick-chat panel on a record page carries that record as its context', async ({ page }) => {
  await login(page);

  const name = `PW Chat Context ${runId}`;
  await page.goto('/Account/create');
  await fieldInput(page, 'name').fill(name);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/Account\/[0-9a-f-]{36}$/, { timeout: 20_000 });

  // The panel on the record page: the chip names the record the answer would be about.
  await page.getByRole('button', { name: 'Ask AI about this record' }).click();
  const chip = page.locator('.carocrm-chat-page-context').first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Account');
  await expect(chip).toContainText(name);

  // Closing the panel sends nothing and creates nothing.
  await page.getByRole('button', { name: 'Ask AI about this record' }).click();
  await expect(chip).toBeHidden();

  // Clean up: the record this run created, found through the list filter.
  await page.goto('/Account');
  const filterArea = page.locator('.carocrm-filter');
  const operatorSelect = filterArea.locator('.ant-select').first();
  await operatorSelect.click();
  await page.keyboard.press('Enter');
  await expect(operatorSelect).toContainText('contains', { timeout: 10_000 });
  await filterArea.locator('input.ant-input').first().fill(name);
  await page.getByRole('button', { name: /Apply/ }).click();
  await expect(page.getByRole('link', { name })).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete record' }).first().click();
  await page.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByRole('link', { name })).toHaveCount(0);
});
