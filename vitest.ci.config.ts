import { defineConfig } from 'vitest/config';

/**
 * Phase 22.22 — the CI-safe test project (`PLAN_Phase_22_Integration_E2E_Hardening.md` §21).
 *
 * The root `vitest.config.ts` collects `apps/api/test/**` and boots the configured database for most
 * of those files. The scheduled CI gate has **no database service** (the owner's decision for 22.22:
 * integration checks are sandbox-only), so this project includes only tests that run against pure
 * logic, fake providers, fake queues and the filesystem:
 *
 *  - every `packages/*\/src/**\/*.test.ts`;
 *  - the API test files listed below, each verified to import no boot helper, `DatabaseService` or
 *    `pool` (see the header of `docs/quality/ci-gates.md`).
 *
 * Adding an API test here is a deliberate act: if it boots the app or touches Postgres it belongs in
 * the sandbox-only integration layer, not in the scheduled gate. Worker tests have their own config
 * and run through `pnpm test:worker`.
 */
const PURE_API_TESTS = [
  'advanced-integrations-connectors.test.ts',
  'advanced-integrations-transformation.test.ts',
  'ai-providers.test.ts',
  'config-jwt-secret.test.ts',
  'crm-chat-contract.test.ts',
  'crm-chat-inline-execution.test.ts',
  'customer-success-domain.test.ts',
  'docs-content.test.ts',
  'error-payload-hygiene.test.ts',
  'esignature-approval-policy.test.ts',
  'esignature-docusign.test.ts',
  'esignature-domain.test.ts',
  'esignature-dropbox-sign.test.ts',
  'esignature-provider.test.ts',
  'esignature-status-mapper.test.ts',
  'lead-score-evaluator.test.ts',
  'lead-score-validator.test.ts',
  'marketing-automation-audience-domain.test.ts',
  'marketing-automation-domain.test.ts',
  'marketing-automation-journey.test.ts',
  'marketing-automation-template-render.test.ts',
  'phase22-provider-contract.test.ts',
  'projects-domain.test.ts',
  'recurrence.test.ts',
  'reports.test.ts',
  'request-scope.test.ts',
  'sales-allocation-math.test.ts',
  'sales-fulfilment.test.ts',
  'sales-inventory-ledger.test.ts',
  'sales-money.test.ts',
  'sales-picking.test.ts',
  'sales-quote-document.test.ts',
  'sales-stock-movement.test.ts',
  'sales-subscriptions.test.ts',
  'sales-supplier-price.test.ts',
  'sales-terms.test.ts',
  'service-desk-domain.test.ts',
  'voice-communications-domain.test.ts',
  'voice-provider-twilio-asterisk.test.ts',
].map((file) => `apps/api/test/${file}`);

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', ...PURE_API_TESTS],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
