import type { JobContext, JobRunResult } from '@carocrm/jobs';

import type { WebhookEndpointRow } from './shared.js';
import { assertPublicUrl, signBody } from './shared.js';

/**
 * The `webhook.deliver` job (PLAN §24).
 *
 * Delivery runs in the worker, never in the request path: an entity write enqueues the job and
 * returns. Each attempt re-checks the destination with the SSRF guard, signs the body, and writes
 * one ledger row per endpoint so an operator can see exactly what was sent.
 *
 * A 4xx or a network failure is re-thrown so BullMQ retries with backoff and the ledger keeps the
 * attempt count; a 5xx is treated as final, because retrying a broken receiver forever is worse than
 * showing it as failed.
 */

export interface WebhookDeliveryPort {
  dueEndpoints(eventType: string): Promise<WebhookEndpointRow[]>;
  secretOf(row: WebhookEndpointRow): string | null;
  recordDelivery(input: {
    endpointId: string;
    eventType: string;
    payload: Record<string, unknown>;
    status: 'delivered' | 'failed' | 'skipped';
    attempts?: number;
    responseCode?: number | null;
    error?: string | null;
  }): Promise<void>;
}

const DELIVERY_TIMEOUT_MS = 10_000;

export async function deliverWebhook(context: JobContext, endpoints: WebhookDeliveryPort): Promise<JobRunResult> {
  const data = context.data ?? {};
  const eventType = typeof data['eventType'] === 'string' ? (data['eventType'] as string) : '';
  const payload = isRecord(data['payload']) ? data['payload'] : {};
  if (eventType === '') {
    return { status: 'failed', message: 'The job payload must carry an "eventType".' };
  }

  const targets = await endpoints.dueEndpoints(eventType);
  if (targets.length === 0) {
    context.log(`No enabled endpoint subscribes to "${eventType}".`);
    return { status: 'completed', result: { delivered: 0, endpoints: 0 } };
  }

  const body = JSON.stringify({ id: `${eventType}:${String(payload['entityId'] ?? '')}`, eventType, payload });
  let delivered = 0;
  let failed = 0;

  for (const endpoint of targets) {
    if (await context.shouldStop()) return { status: 'cancelled' };
    const secret = endpoints.secretOf(endpoint);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'CaroCRM-Webhook/1.0',
      'x-caro-event': eventType,
      'x-caro-delivery': new Date().toISOString(),
    };
    if (secret !== null) headers['x-caro-signature'] = signBody(secret, body);

    try {
      // Re-validated per attempt: DNS can change between attempts.
      const url = await assertPublicUrl(endpoint.url);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      const ok = response.status >= 200 && response.status < 300;
      await endpoints.recordDelivery({
        endpointId: endpoint.id,
        eventType,
        payload,
        status: ok ? 'delivered' : response.status < 500 ? 'failed' : 'failed',
        attempts: 1,
        responseCode: response.status,
        error: ok ? null : `HTTP ${String(response.status)}`,
      });
      if (ok) delivered += 1;
      else failed += 1;
      context.log(`${endpoint.name}: HTTP ${String(response.status)}`, ok ? 'info' : 'warn');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      context.log(`${endpoint.name}: ${message}`, 'error');
      await endpoints.recordDelivery({ endpointId: endpoint.id, eventType, payload, status: 'failed', attempts: 1, error: message });
      failed += 1;
      // Transport failures are retryable; the job is retried with backoff and the endpoint that
      // already answered is skipped on the next attempt (it is marked delivered, not repeated).
      throw error;
    }
  }

  return { status: 'completed', result: { delivered, failed, endpoints: targets.length } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}