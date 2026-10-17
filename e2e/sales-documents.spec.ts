import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 19-S.17 tasks 1, 2 and 8 — the commercial **document screen** in a browser.
 *
 * What this spec is for, and what it deliberately is not:
 *
 *  - it proves the document's own commands are on the screen — the action bar is built from the
 *    server's descriptor, so "Issue" appears for a draft invoice and "Void" for an issued one — and
 *    that the two guards around them work in the browser: issuing asks first, and a privileged
 *    correction will not submit without a reason;
 *  - it checks the parts a unit test cannot see: the bar is reachable **by keyboard**, it wraps instead
 *    of overflowing at a phone viewport, and the quote's Send is not duplicated by the action bar;
 *  - it does **not** re-test the state machine. The transitions themselves (number allocation, locking,
 *    the snapshot, the audit reason) are covered over HTTP by `apps/api/test/sales-documents.test.ts`;
 *    here every record stays a **draft** and is deleted at the end, because an issued document is
 *    deliberately not deletable (§4.9) and a browser run should not leave one behind.
 */

const ADMIN = {
  user: process.env.E2E_ADMIN_LOGIN ?? 'admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'admin',
};
const run = Date.now().toString(36);

async function login(page: Page): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('User name').fill(ADMIN.user);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  return page.evaluate(() => window.localStorage.getItem('carocrm.accessToken') ?? '');
}

/** A draft with one priced line, created through the same command the create screen uses. */
async function createDraft(page: Page, token: string, kind: 'invoice' | 'quote'): Promise<string> {
  const response = await page.request.post('/api/v1/Sales/document', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      kind,
      data: { name: `e2e-sales-${run} ${kind}`, currency: 'USD', ...(kind === 'quote' ? { quoteDate: '2026-10-15' } : { invoiceDate: '2026-10-15' }) },
      items: [{ name: `e2e-sales-${run} line`, quantity: '1', unitPrice: '100.00', taxRatePercent: '0' }],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return String((await response.json()).id);
}

/** Deleting a **draft** is the one supported removal (§4.9), which is how this spec leaves no rows. */
async function deleteDraft(page: Page, token: string, kind: string, id: string): Promise<void> {
  const response = await page.request.delete(`/api/v1/Sales/document/${kind}/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect([204, 404]).toContain(response.status());
}

/** The card that owns the document's lines and its action bar. */
function documentCard(page: Page) {
  return page.locator('.ant-card').filter({ hasText: 'Line items' }).first();
}

function visibleModal(page: Page) {
  return page.locator('.ant-modal:visible').last();
}

test.describe('a commercial document in the browser (19-S.17)', () => {
  test('a draft invoice offers its own commands, confirms the issuing click, and stays a draft when the click is withdrawn', async ({ page }) => {
    const token = await login(page);
    const invoiceId = await createDraft(page, token, 'invoice');
    try {
      await page.goto(`/Invoice/${invoiceId}`);

      // The bar comes from `view.actions`: a draft invoice's only command is Issue, and the state is
      // the metadata's own `draft`.
      const card = documentCard(page);
      const issue = card.getByRole('button', { name: 'Issue', exact: true });
      await expect(issue).toBeVisible();
      await expect(page.locator('.lizant-pill', { hasText: 'draft' }).first()).toBeVisible();
      // Nothing is locked yet, so the issued-document warning must not be on screen.
      await expect(page.getByText('This document is issued and locked')).toHaveCount(0);

      // Issuing is the one click that deserves a question: it takes the number and freezes the document.
      await issue.click();
      const confirm = visibleModal(page);
      await expect(confirm.getByText(/takes its official number and locks/)).toBeVisible();
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(visibleModal(page)).toHaveCount(0);
      // Withdrawn: the document is untouched and still offers the same command.
      await expect(issue).toBeVisible();
      await expect(page.locator('.lizant-pill', { hasText: 'draft' }).first()).toBeVisible();

      // The same button, reached and pressed from the keyboard — the screen is not mouse-only.
      await issue.focus();
      await expect(issue).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(visibleModal(page).getByText(/takes its official number and locks/)).toBeVisible();
      // Dismissed with the dialog's own button: antd's `Modal.confirm` does not close on Escape, and a
      // spec that pretended it did would be asserting a behaviour the screen does not have.
      await visibleModal(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(visibleModal(page)).toHaveCount(0);

      // A phone viewport: the bar wraps and nothing overflows sideways.
      await page.setViewportSize({ width: 390, height: 844 });
      // The rail re-renders as an off-canvas drawer at this width, and that re-render is itself what
      // gives the content the full viewport — so wait for the drawer before measuring anything.
      const sider = page.locator('.lizant-sider--drawer');
      await expect(sider).toHaveCount(1);
      await expect(issue).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'horizontal overflow at 390px').toBeLessThanOrEqual(1);

      // The drawer is closed until the header toggle opens it, and Escape closes it again — the
      // keyboard path a touchscreen user cannot use. Both are polled: the drawer animates, so a
      // one-shot read catches it mid-slide.
      const shift = () => sider.evaluate((node) => node.getBoundingClientRect().left);
      await expect.poll(shift, { timeout: 5_000 }).toBeLessThan(0);
      await page.locator('.lizant-collapse-toggle').click();
      await expect.poll(shift, { timeout: 5_000 }).toBe(0);
      await page.keyboard.press('Escape');
      await expect.poll(shift, { timeout: 5_000 }).toBeLessThan(0);
    } finally {
      await deleteDraft(page, token, 'invoice', invoiceId);
    }
  });

  test('a quote keeps its own Send and asks for a reason before cancelling', async ({ page }) => {
    const token = await login(page);
    const quoteId = await createDraft(page, token, 'quote');
    try {
      await page.goto(`/Quote/${quoteId}`);

      const card = documentCard(page);
      // A quote issues through Send — the button that renders the document and picks a recipient. The
      // action bar filters that transition out, so exactly one Send is on the screen. Its accessible
      // name carries the icon's label too ("send Send"), which is why the match is not exact.
      await expect(card.getByRole('button', { name: 'Send' })).toHaveCount(1);
      await expect(card.getByRole('button', { name: 'Issue', exact: true })).toHaveCount(0);

      // Cancel is a privileged correction: the modal asks for its reason *before* the request.
      await card.getByRole('button', { name: 'Cancel', exact: true }).click();
      const modal = visibleModal(page);
      await expect(modal.getByText('Reason for Cancel')).toBeVisible();
      const submit = modal.getByRole('button', { name: 'Cancel', exact: true });
      await expect(submit).toBeDisabled();

      const textarea = modal.locator('textarea');
      await textarea.fill(`e2e-sales-${run} withdrawn by the operator`);
      await expect(submit).toBeEnabled();

      // Dismissed, not submitted: the quote is still a draft, which is what makes it deletable.
      await modal.getByRole('button', { name: 'Keep as is', exact: true }).click();
      await expect(visibleModal(page)).toHaveCount(0);
      await expect(page.locator('.lizant-pill', { hasText: 'draft' }).first()).toBeVisible();
      await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    } finally {
      await deleteDraft(page, token, 'quote', quoteId);
    }
  });

  test('an opportunity offers the three documents it can produce and hands off to the create screen', async ({ page }) => {
    const token = await login(page);
    const auth = { authorization: `Bearer ${token}` };
    const account = await page.request.post('/api/v1/Account', { headers: auth, data: { name: `e2e-sales-${run} account` } });
    expect(account.status()).toBe(201);
    const accountId = String((await account.json()).id);
    const deal = await page.request.post('/api/v1/Opportunity', {
      headers: auth,
      data: { name: `e2e-sales-${run} deal`, accountId, amount: '2500.00', stage: 'Proposal' },
    });
    expect(deal.status()).toBe(201);
    const dealId = String((await deal.json()).id);

    try {
      await page.goto(`/Opportunity/${dealId}`);
      const panel = page.locator('.ant-card').filter({ hasText: 'Commercial documents' }).first();
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Create quote' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Create sales order' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Create invoice' })).toBeVisible();

      // The hand-off lands on the create screen **with the deal in the URL**, which is what routes the
      // save through `POST /Sales/document/fromOpportunity` — the command that carries the party and
      // the provenance. The command's own behaviour (guards, idempotency, ACL) is pinned over HTTP by
      // `apps/api/test/sales-opportunity-source.test.ts`; what this asserts is that the screen the
      // operator reaches is that path, and that it asks for the lines a document needs before saving.
      await panel.getByRole('button', { name: 'Create quote' }).click();
      await expect(page).toHaveURL(new RegExp(`/Quote/create\\?opportunityId=${dealId}`));
      await expect(page.getByText('Line items').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    } finally {
      await page.request.delete(`/api/v1/Opportunity/${dealId}`, { headers: auth });
      await page.request.delete(`/api/v1/Account/${accountId}`, { headers: auth });
    }
  });
});
