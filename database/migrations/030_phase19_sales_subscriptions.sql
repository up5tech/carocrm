-- Phase 19-S.16 — Subscriptions and recurring invoice generation

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_period_identity
  ON entity_records (((attrs ->> 'subscriptionId')), ((attrs ->> 'periodStart')), ((attrs ->> 'periodEnd')))
  WHERE entity_type = 'SubscriptionPeriod' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_period_idempotency
  ON entity_records ((attrs ->> 'idempotencyKey'))
  WHERE entity_type = 'SubscriptionPeriod'
    AND (attrs ->> 'idempotencyKey') IS NOT NULL
    AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_period_invoice
  ON entity_records ((attrs ->> 'invoiceId'))
  WHERE entity_type = 'SubscriptionPeriod'
    AND (attrs ->> 'invoiceId') IS NOT NULL
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_subscription_period_subscription
  ON entity_records ((attrs ->> 'subscriptionId'))
  WHERE entity_type = 'SubscriptionPeriod' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_subscription_status
  ON entity_records ((attrs ->> 'status'))
  WHERE entity_type = 'Subscription' AND deleted_at IS NULL;
