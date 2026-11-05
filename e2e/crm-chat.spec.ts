import { expect, type Page, test } from '@playwright/test';

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
