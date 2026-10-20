/**
 * Phase 19-INT.12 — the webhook path prefix
 * (`PLAN_Phase_19_Advanced_Integrations.md` §10; `19-INT.12`).
 *
 * The prefix is a **constant** in its own module, because two unrelated places need it and must
 * not drift: the Fastify `preParsing` hook that captures the raw body, and the controller that
 * serves the callback. A literal typed twice is a literal that will eventually differ.
 */
export const ADVANCED_INTEGRATIONS_WEBHOOK_PREFIX = '/api/v1/integrations/advanced-integrations';
