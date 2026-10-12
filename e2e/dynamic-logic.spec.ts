import { type APIRequestContext, expect, type Locator, type Page,test } from '@playwright/test';

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const runId = Date.now().toString(36);
const entity = `AgentE2eLogic${runId.replace(/[^A-Za-z0-9]/g, '')}`;

/** Metadata and record fixtures go through the API: the SPA has no admin form for rules yet. */
async function apiToken(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

function fieldInput(page: Page, label: string): Locator {
  const spaced = label.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  const text = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return page
    .locator('.ant-form-item')
    .filter({ has: page.locator('label', { hasText: new RegExp(`^${text}$`) }) })
    .first()
    .locator('input, textarea')
    .first();
}

function formItem(page: Page, label: string): Locator {
  const spaced = label.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  const text = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return page.locator('.ant-form-item').filter({ has: page.locator('label', { hasText: new RegExp(`^${text}$`) }) }).first();
}

/** antd renders a Select placeholder as a span, not an input attribute, and portals its options. */
function selectByPlaceholder(page: Page, placeholder: string): Locator {
  return page.locator('.ant-select').filter({ has: page.getByText(placeholder, { exact: true }) }).first();
}

/** The option list is virtualised, so the field is typed into the search box before picking. */
async function pickOption(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text);
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: text })
    .first()
    .click();
}

async function createProbeEntity(request: APIRequestContext, token: string): Promise<void> {
  const response = await request.post(`/api/v1/Metadata/${entity}`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      label: 'E2E Logic',
      fields: {
        type: { type: 'varchar', inEdit: true, inDetail: true },
        taxId: { type: 'varchar', inEdit: true, inDetail: true },
        industry: { type: 'varchar', inEdit: true, inDetail: true },
        nameUpper: { type: 'formula', formula: "upper(field('name'))" },
      },
      dynamicLogic: {
        rules: [
          {
            name: 'customerTax',
            when: { field: 'type', operator: 'equals', value: 'Customer' },
            then: { setRequired: ['taxId'], hide: ['industry'] },
          },
        ],
      },
    },
  });
  expect(response.status()).toBe(200);
}

test.describe('dynamic logic in the generated form (PLAN §21)', () => {
  test('hides, requires and validates fields from metadata rules', async ({ page, request }) => {
    const token = await apiToken(request);
    await createProbeEntity(request, token);

    try {
      await login(page);
      await page.goto(`/${entity}/create`);

      await expect(formItem(page, 'taxId')).toBeVisible();
      await expect(formItem(page, 'industry')).toBeVisible();

      await fieldInput(page, 'name').fill(`PW Logic ${runId}`);
      await fieldInput(page, 'type').fill('Customer');

      // The rule makes Tax Id required and hides Industry without a round-trip.
      await expect(formItem(page, 'taxId').locator('label')).toHaveClass(/ant-form-item-required/);
      await expect(formItem(page, 'industry')).toHaveCount(0);

      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Tax Id is required.')).toBeVisible();

      await fieldInput(page, 'taxId').fill(`TAX-${runId}`);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page).toHaveURL(new RegExp(`/${entity}/[0-9a-f-]{36}$`), { timeout: 20_000 });

      const detailUrl = page.url();
      const recordId = detailUrl.split('/').pop() ?? '';
      expect(recordId).toBeTruthy();

      await expect(page.getByText(`TAX-${runId}`).first()).toBeVisible();
      // The formula field is computed server-side and shown read-only on the detail view.
      await expect(page.getByText(`PW LOGIC ${runId.toUpperCase()}`).first()).toBeVisible();
      // Industry is hidden on detail too, because the same rule set drives both views.
      await expect(page.getByText('Industry', { exact: true })).toHaveCount(0);

      // The server refuses the same violation for an API client that skips the UI.
      const bypass = await request.patch(`/api/v1/${entity}/${recordId}`, {
        headers: { authorization: `Bearer ${token}` },
        data: { taxId: '' },
      });
      expect(bypass.status()).toBe(422);

      await request.delete(`/api/v1/${entity}/${recordId}`, { headers: { authorization: `Bearer ${token}` } });
    } finally {
      await request.post(`/api/v1/Metadata/${entity}`, {
        headers: { authorization: `Bearer ${token}` },
        data: { isEntity: false, dynamicLogic: { rules: [] } },
      });
    }
  });

  test('the Entity Manager can author a rule that the generated form then follows', async ({ page, request }) => {
    const admin = `AgentE2eAuthor${runId.replace(/[^A-Za-z0-9]/g, '')}`;
    const token = await apiToken(request);
    const created = await request.post(`/api/v1/Metadata/${admin}`, {
      headers: { authorization: `Bearer ${token}` },
      data: {
        label: 'E2E Author',
        fields: {
          kind: { type: 'varchar', inEdit: true },
          vatCode: { type: 'varchar', inEdit: true },
        },
      },
    });
    expect(created.status()).toBe(200);

    try {
      await login(page);
      page.setDefaultTimeout(8000);
      await page.goto('/admin/entity-manager');
      await page.locator('.ant-table-row').filter({ hasText: 'E2E Author' }).first().click();
      await page.getByRole('tab', { name: /^Logic/ }).click();

      await expect(page.getByRole('button', { name: 'Add rule' })).toBeVisible();
      await page.getByPlaceholder('rule name').fill('vatForCompany');
      await selectByPlaceholder(page, 'when field').click();
      await pickOption(page, 'kind');
      await page.getByPlaceholder('compare value').fill('Company');
      // "Make required" is the default action; only the target fields still have to be named.
      await selectByPlaceholder(page, 'then fields').click();
      await pickOption(page, 'vatCode');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Add rule' }).click();

      await expect(page.getByText('Rule added.')).toBeVisible();
      const stored = await request.get(`/api/v1/Metadata/${admin}`, { headers: { authorization: `Bearer ${token}` } });
      const logic = ((await stored.json()) as { dynamicLogic?: { rules?: Record<string, unknown>[] } }).dynamicLogic;
      expect(logic?.rules ?? []).toHaveLength(1);

      // The rule the admin just wrote drives the generated form.
      await page.goto(`/${admin}/create`);
      await fieldInput(page, 'name').fill(`PW Author ${runId}`);
      await fieldInput(page, 'kind').fill('Company');
      await expect(formItem(page, 'vatCode').locator('label')).toHaveClass(/ant-form-item-required/);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Vat Code is required.')).toBeVisible();

      await fieldInput(page, 'vatCode').fill(`VAT-${runId}`);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page).toHaveURL(new RegExp(`/${admin}/[0-9a-f-]{36}$`), { timeout: 20_000 });
    } finally {
      const recordList = await request.get(`/api/v1/${admin}`, { headers: { authorization: `Bearer ${token}` } });
      if (recordList.ok()) {
        const rows = (await recordList.json()) as { list: { id: string }[] };
        for (const row of rows.list) {
          await request.delete(`/api/v1/${admin}/${row.id}`, { headers: { authorization: `Bearer ${token}` } });
        }
      }
      await request.post(`/api/v1/Metadata/${admin}`, {
        headers: { authorization: `Bearer ${token}` },
        data: { isEntity: false, dynamicLogic: { rules: [] } },
      });
    }
  });
});
