import { expect, type Page, test } from '@playwright/test';

/**
 * The Email Template designer (PLAN Phase 11 "Email templates").
 *
 * The flow an operator walks: open a template, read the draft next to the rendered message,
 * personalise the preview with a sample record they may read, and see the screen name the
 * placeholder that would go out empty. Saving is the generic entity CRUD, so the record the
 * screen writes is read back through the API and deleted again — nothing is left in the
 * shared development database (AGENTS.MD §3.3).
 *
 * The HTML part has two faces: the visual canvas (the default) and the source editor. The
 * visual test asserts the export is email-safe — inline `style` attributes, not a stylesheet
 * — because that is the form Outlook and friends actually render.
 */

const ADMIN = { user: process.env.E2E_ADMIN_LOGIN ?? 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' };
const runId = Date.now().toString(36);

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

/** The mode switch in the card header: visual canvas | HTML source | plain text. */
async function switchMode(page: Page, name: string): Promise<void> {
  // Click the segmented item (the label), not the radio input: antd covers the input with
  // the sliding thumb, so a click on the input never passes Playwright's hit-target check.
  await page.locator('.ant-segmented-item').filter({ hasText: name }).click();
}

test.describe('email template designer', () => {
  test('a draft is written on the left, rendered on the right and saved as a record', async ({ page, request }) => {
    const loginRes = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
    expect(loginRes.ok()).toBeTruthy();
    const { accessToken } = (await loginRes.json()) as { accessToken: string };
    const headers = { authorization: `Bearer ${accessToken}` };

    const contacts = await request.get('/api/v1/Contact?maxSize=1', { headers });
    const contact = ((await contacts.json()) as { list: unknown[] }).list[0];
    test.skip(contact === undefined, 'the development database holds no contact to personalise with');

    await login(page);
    await page.goto('/EmailTemplate/create');
    await expect(page.locator('.carocrm-etpl')).toBeVisible();

    // The source editor is one mode of the workspace; switch to it before typing markup.
    await switchMode(page, 'HTML');
    await expect(page.locator('textarea.carocrm-etpl-source')).toBeVisible();

    await page.locator('.carocrm-etpl-meta input').first().fill(`AGENT_TEST designer ${runId}`);
    await page.locator('input[data-token-target="subject"]').fill('Hello {{firstName}}');
    await page.locator('textarea.carocrm-etpl-source').first().fill('<p>Hello {{firstName}}, and {{noSuchField}}.</p>');

    // The palette names the fields of the sample type, and a chip drops its token at the cursor.
    const chip = page.locator('.carocrm-etpl-chip').filter({ hasText: '{{lastName}}' });
    await expect(chip.first()).toBeVisible();
    await page.locator('textarea.carocrm-etpl-source').first().click();
    await page.keyboard.press('End');
    await chip.first().click();
    await expect(page.locator('textarea.carocrm-etpl-source').first()).toHaveValue(/<\/p>\{\{lastName\}\}$/);

    // The preview is a server render, so its placeholder report is the server's answer, not a guess.
    await expect(page.locator('.carocrm-etpl-iframe')).toBeVisible();
    await expect(page.locator('.carocrm-etpl-iframe').contentFrame().locator('body')).toContainText('{{noSuchField}}');

    await page.locator('.carocrm-etpl-sample-record').click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').first().click();
    const frameBody = page.locator('.carocrm-etpl-iframe').contentFrame().locator('body');
    await expect(frameBody).not.toContainText('{{firstName}}', { timeout: 15_000 });
    // The warning is the server's report; matched by role of the element, not by its wording.
    await expect(page.locator('.carocrm-etpl-preview .ant-alert-warning')).toContainText('{{noSuchField}}');

    // A phone frame is the same content at 375px, not a different document.
    await page.locator('.carocrm-etpl-preview-bar .ant-segmented-item').nth(1).click();
    await expect(page.locator('.carocrm-etpl-frame')).toHaveCSS('max-width', '375px');

    await page.locator('.carocrm-etpl-card .ant-card-extra button[type="submit"]').click();
    await expect(page).toHaveURL(/\/EmailTemplate\/[0-9a-f-]{36}$/, { timeout: 20_000 });
    const id = page.url().split('/').pop() as string;

    const stored = await request.get(`/api/v1/EmailTemplate/${id}`, { headers });
    expect(stored.ok()).toBeTruthy();
    const record = (await stored.json()) as Record<string, unknown>;
    expect(record['subject']).toBe('Hello {{firstName}}');
    expect(String(record['bodyHtml'])).toContain('{{noSuchField}}');

    const deleted = await request.delete(`/api/v1/EmailTemplate/${id}`, { headers });
    expect(deleted.ok()).toBeTruthy();
  });

  test('a design is composed on the canvas and saved as email-safe HTML', async ({ page, request }) => {
    const loginRes = await request.post('/api/v1/Authentication', { data: { userName: ADMIN.user, password: ADMIN.password } });
    expect(loginRes.ok()).toBeTruthy();
    const { accessToken } = (await loginRes.json()) as { accessToken: string };
    const headers = { authorization: `Bearer ${accessToken}` };

    await login(page);
    await page.goto('/EmailTemplate/create');

    // The canvas is the default face of the workspace.
    await expect(page.locator('.carocrm-gjs')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Visual design' })).toBeChecked();

    await page.locator('.carocrm-etpl-meta input').first().fill(`AGENT_TEST visual ${runId}`);
    await page.locator('input[data-token-target="subject"]').fill('Visual {{firstName}}');

    // Dropping a block appends an email-safe table section to the canvas.
    const section = page.locator('.gjs-block').filter({ hasText: '1 column' });
    await expect(section).toBeVisible();
    await section.click();
    const canvas = page.locator('.gjs-frame').contentFrame();
    await expect(canvas.locator('table').first()).toBeVisible();

    // A placeholder chip reaches into the canvas and lands in the design.
    await page.locator('.carocrm-etpl-chip').filter({ hasText: '{{lastName}}' }).first().click();

    // The server preview is the same render the source modes show, now behind the preview button.
    await page.getByRole('button', { name: /Preview/ }).click();
    const previewBody = page.locator('.carocrm-etpl-iframe').contentFrame().locator('body');
    await expect(previewBody).toContainText('{{lastName}}', { timeout: 15_000 });

    // The drawer's mask covers the card header, so it closes before the save button is reachable.
    // antd keeps the closed drawer node mounted, so the mask's departure is the honest signal.
    await page.locator('.ant-drawer-close').click();
    await expect(page.locator('.ant-drawer-mask')).toHaveCount(0);

    await page.locator('.carocrm-etpl-card .ant-card-extra button[type="submit"]').click();
    await expect(page).toHaveURL(/\/EmailTemplate\/[0-9a-f-]{36}$/, { timeout: 20_000 });
    const id = page.url().split('/').pop() as string;

    const stored = await request.get(`/api/v1/EmailTemplate/${id}`, { headers });
    expect(stored.ok()).toBeTruthy();
    const record = (await stored.json()) as Record<string, unknown>;
    const bodyHtml = String(record['bodyHtml']);
    // The placeholder is part of the design, and the styles are inline — the whole point of
    // the export: a stylesheet is invisible to Outlook's rendering engine.
    expect(bodyHtml).toContain('{{lastName}}');
    expect(bodyHtml).toMatch(/style="[^"]*padding/);
    expect(bodyHtml).not.toContain('<style');

    const deleted = await request.delete(`/api/v1/EmailTemplate/${id}`, { headers });
    expect(deleted.ok()).toBeTruthy();
  });

  test('markup typed into the source cannot run against the editor session', async ({ page }) => {
    await login(page);
    await page.goto('/EmailTemplate/create');
    await switchMode(page, 'HTML');
    await page.locator('textarea.carocrm-etpl-source').first().fill('<p>probe</p><img src=x onerror="window.__pwned=1">');
    await expect(page.locator('.carocrm-etpl-iframe')).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
  });
});
