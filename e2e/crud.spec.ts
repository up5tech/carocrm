import { expect, type Locator, type Page,test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const runId = Date.now().toString(36);

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

/** Generated forms show human labels ("billingAddressCity" → "Billing Address City"); tests address fields by name. */
function labelFor(fieldName: string): string {
  const spaced = fieldName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Input of the generated form item whose label matches exactly. */
function fieldInput(page: Page, label: string): Locator {
  const text = labelFor(label);
  const item = page.locator('.ant-form-item').filter({ has: page.locator('label', { hasText: new RegExp(`^${text}$`) }) }).first();
  return item.locator('input, textarea').first();
}

function rowDeleteButton(page: Page, index = 0): Locator {
  return page.getByRole('button', { name: 'Delete record' }).nth(index);
}

async function confirmLastPopover(page: Page) {
  await page.getByRole('button', { name: 'Confirm delete' }).click();
}

async function createRecord(page: Page, entity: string, values: Record<string, string>) {
  await page.goto(`/${entity}/create`);
  for (const [label, value] of Object.entries(values)) {
    await fieldInput(page, label).fill(value);
  }
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(new RegExp(`/${entity}/[0-9a-f-]{36}$`), { timeout: 20_000 });
}

test.describe('CaroCRM UI', () => {
  test('login → create → list → edit → delete an Account', async ({ page }) => {
    await login(page);

    const name = `PW Account ${runId}`;
    await createRecord(page, 'Account', { name, website: 'https://playwright.example', industry: 'Software' });
    await expect(page.getByText(name).first()).toBeVisible();
    const detailUrl = page.url();

    await page.getByRole('button', { name: /Edit/ }).click();
    await expect(page).toHaveURL(/\/edit$/);
    await fieldInput(page, 'industry').fill('Logistics');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(detailUrl);
    await expect(page.getByText('Logistics').first()).toBeVisible();

    await page.goto('/Account');
    const filterArea = page.locator('.lizant-filter');
    const operatorSelect = filterArea.locator('.ant-select').first();
    await operatorSelect.click();
    // antd renders the option list in a portal; keyboard selection is deterministic
    await page.keyboard.press('Enter');
    await expect(operatorSelect).toContainText('contains', { timeout: 10_000 });
    const filterValue = filterArea.locator('input.ant-input').first();
    await filterValue.fill(name);
    await page.getByRole('button', { name: /Apply/ }).click();
    // the display column renders as the record link
    await expect(page.getByRole('link', { name })).toHaveCount(1);

    await rowDeleteButton(page).click();
    await confirmLastPopover(page);
    await expect(page.getByRole('link', { name })).toHaveCount(0);
  });

  test('entity manager: custom field becomes usable in the generated form', async ({ page }) => {
    await login(page);
    const field = `pwField${runId}`;

    await page.goto('/admin/entity-manager');
    await expect(page.getByRole('heading', { name: 'Entity Manager' })).toBeVisible();
    await page.locator('.ant-table-tbody tr', { hasText: 'Account' }).first().click();

    await page.getByPlaceholder('fieldName').fill(field);
    await page.getByRole('button', { name: 'Add field' }).click();
    await expect(page.locator('.ant-table-tbody').filter({ hasText: field }).first()).toBeVisible();

    await createRecord(page, 'Account', { name: `PW Field Account ${runId}`, [field]: 'dynamic-value' });
    await expect(page.getByText('dynamic-value').first()).toBeVisible();
  });

  test('entity manager: a brand new entity gets working CRUD from metadata', async ({ page }) => {
    await login(page);
    const entity = `PwSite${runId.charAt(0).toUpperCase()}${runId.slice(1)}`;

    await page.goto('/admin/entity-manager');
    await page.getByRole('button', { name: /New entity/ }).click();
    const modal = page.locator('.ant-modal-content');
    await modal.getByLabel('Name (PascalCase)').fill(entity);
    await modal.getByLabel('Label').fill(entity);
    await modal.getByRole('button', { name: 'OK' }).click();
    await expect(page.locator('.ant-table-tbody tr', { hasText: entity }).first()).toBeVisible();

    await createRecord(page, entity, { name: `${entity} record` });
    await expect(page.getByText(`${entity} record`).first()).toBeVisible();
  });

  test('relationship panel lists a linked contact', async ({ page }) => {
    await login(page);
    const account = `PW Rel Account ${runId}`;
    const contact = `PW Rel Contact ${runId}`;

    await createRecord(page, 'Account', { name: account });
    const accountUrl = page.url();

    await page.goto('/Contact/create');
    await fieldInput(page, 'name').fill(contact);
    await fieldInput(page, 'lastName').fill(contact);
    // link fields are labelled with their target entity ("accountId" → "Account")
    const accountPicker = page
      .locator('.ant-form-item')
      .filter({ has: page.locator('label', { hasText: /^Account$/ }) })
      .first()
      .locator('.ant-select-selector');
    await accountPicker.click();
    // options load when the dropdown opens; then filter by typing
    await expect(page.locator('.ant-select-item-option').first()).toBeVisible({ timeout: 15_000 });
    await accountPicker.locator('input').fill(account);
    await page.locator('.ant-select-item-option', { hasText: account }).first().click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(account).first()).toBeVisible();

    await page.goto(accountUrl);
    const contactsPanel = page.locator('.ant-card').filter({ hasText: 'contacts' }).first();
    await expect(contactsPanel.getByText(contact)).toBeVisible();
  });
});
