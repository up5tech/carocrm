import { AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import type { ExtensionDb, ExtensionPrincipal } from '@carocrm/extension-sdk';
import { EXTENSION_DATABASE, EXTENSION_PRINCIPAL } from '@carocrm/extension-sdk';
import { Inject, Injectable } from '@nestjs/common';

import type {
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WebhookEndpointView,
} from './shared.js';
import { assertPublicUrl, decodeSecret, encodeSecret, newEndpointId, parseEvents, SUPPORTED_EVENTS, toEndpointView,WebhookSecurityError } from './shared.js';

/**
 * Endpoint administration and event fan-out for `webhook-integration`.
 *
 * Registering an endpoint is an administrator action: the URLs are outbound destinations this
 * process will contact on its own initiative, so a regular user must not be able to add one.
 * Delivery happens in the worker, never in the request path (PLAN §28: nothing sends from the API).
 */
@Injectable()
export class WebhookEndpointService {
  constructor(
    @Inject(EXTENSION_DATABASE) private readonly db: ExtensionDb,
    @Inject(EXTENSION_PRINCIPAL) private readonly principal: ExtensionPrincipal,
  ) {}

  async list(): Promise<{ list: WebhookEndpointView[]; total: number }> {
    this.requireAdmin();
    const rows = await this.db.query<WebhookEndpointRow>(
      'SELECT id, name, url, events, secret_encrypted, enabled, created_at, modified_at FROM extension_webhook_endpoints ORDER BY name ASC',
    );
    const list = rows.map(toEndpointView);
    return { list, total: list.length };
  }

  async get(id: string): Promise<WebhookEndpointView> {
    this.requireAdmin();
    const rows = await this.db.query<WebhookEndpointRow>(
      'SELECT id, name, url, events, secret_encrypted, enabled, created_at, modified_at FROM extension_webhook_endpoints WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new NotFoundError(`Webhook endpoint "${id}" does not exist.`);
    return toEndpointView(row);
  }

  async create(input: CreateEndpointInput): Promise<WebhookEndpointView> {
    this.requireAdmin();
    const name = requireText(input.name, 'name', 120);
    const url = requireUrl(await assertPublicUrl(requireText(input.url, 'url', 2048)));
    const events = requireEvents(input.events);
    const secret = encodeSecret(input.secret ?? '');
    const row: WebhookEndpointRow = {
      id: newEndpointId(),
      name,
      url,
      events,
      secret_encrypted: secret,
      enabled: input.enabled ?? true,
      created_at: new Date(),
      modified_at: new Date(),
    };
    await this.db.query(
      `INSERT INTO extension_webhook_endpoints (id, name, url, events, secret_encrypted, enabled, created_at, modified_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [row.id, row.name, row.url, JSON.stringify(events), row.secret_encrypted, row.enabled, row.created_at, row.modified_at],
    );
    return toEndpointView(row);
  }

  async update(id: string, input: CreateEndpointInput): Promise<WebhookEndpointView> {
    this.requireAdmin();
    const current = await this.get(id);
    const name = input.name === undefined ? current.name : requireText(input.name, 'name', 120);
    const url = input.url === undefined ? current.url : requireUrl(await assertPublicUrl(input.url));
    const events = input.events === undefined ? current.events : requireEvents(input.events);
    const secret = input.secret === undefined ? undefined : encodeSecret(input.secret);
    const enabled = input.enabled ?? current.enabled;

    await this.db.query(
      `UPDATE extension_webhook_endpoints
          SET name = $2, url = $3, events = $4::jsonb, enabled = $5, modified_at = $6,
              secret_encrypted = COALESCE($7, secret_encrypted)
        WHERE id = $1`,
      [current.id, name, url, JSON.stringify(events), enabled, new Date(), secret],
    );
    return this.get(current.id);
  }

  async remove(id: string): Promise<{ id: string; removed: true }> {
    this.requireAdmin();
    const current = await this.get(id);
    await this.db.query('DELETE FROM extension_webhook_deliveries WHERE endpoint_id = $1', [current.id]);
    await this.db.query('DELETE FROM extension_webhook_endpoints WHERE id = $1', [current.id]);
    return { id: current.id, removed: true };
  }

  /** Recent deliveries for one endpoint; the ledger an operator reads when debugging a receiver. */
  async deliveries(id: string): Promise<{ list: DeliveryView[]; total: number }> {
    this.requireAdmin();
    const rows = await this.db.query<WebhookDeliveryRow>(
      `SELECT id, endpoint_id, event_type, payload, status, attempts, response_code, error, created_at, modified_at
         FROM extension_webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [id],
    );
    const list = rows.map((row) => ({
      id: row.id,
      endpointId: row.endpoint_id,
      eventType: row.event_type,
      status: row.status,
      attempts: row.attempts,
      responseCode: row.response_code,
      error: row.error,
      createdAt: new Date(row.created_at).toISOString(),
    }));
    return { list, total: list.length };
  }

  /** Public surface used by the worker's delivery job (no principal involved there). */
  async dueEndpoints(eventType: string): Promise<WebhookEndpointRow[]> {
    const rows = await this.db.query<WebhookEndpointRow>(
      'SELECT id, name, url, events, secret_encrypted, enabled, created_at, modified_at FROM extension_webhook_endpoints WHERE enabled = TRUE',
    );
    return rows.filter((row) => parseEvents(row.events).includes(eventType));
  }

  async recordDelivery(input: {
    endpointId: string;
    eventType: string;
    payload: Record<string, unknown>;
    status: 'delivered' | 'failed' | 'skipped';
    attempts?: number;
    responseCode?: number | null;
    error?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO extension_webhook_deliveries (id, endpoint_id, event_type, payload, status, attempts, response_code, error, created_at, modified_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $9)`,
      [
        newEndpointId(),
        input.endpointId,
        input.eventType,
        JSON.stringify(input.payload),
        input.status,
        input.attempts ?? 1,
        input.responseCode ?? null,
        input.error ?? null,
        new Date(),
      ],
    );
  }

  secretOf(row: WebhookEndpointRow): string | null {
    return decodeSecret(row);
  }

  private requireAdmin(): void {
    if (!this.principal.isAdmin) throw new AuthorizationDeniedError('Administrator access is required to manage webhook endpoints.');
  }
}

export interface CreateEndpointInput {
  name?: string | undefined;
  url?: string | undefined;
  events?: unknown;
  secret?: string | undefined;
  enabled?: boolean | undefined;
}

export interface DeliveryView {
  id: string;
  endpointId: string;
  eventType: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`A webhook endpoint needs a "${field}".`);
  if (value.length > maxLength) throw new ValidationError(`"${field}" must be at most ${String(maxLength)} characters.`);
  return value.trim();
}

function requireUrl(url: URL): string {
  return url.toString();
}

function requireEvents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError('A webhook endpoint must subscribe to at least one event.', { events: SUPPORTED_EVENTS });
  }
  const events = value.filter((event): event is string => typeof event === 'string');
  const unknown = events.filter((event) => !(SUPPORTED_EVENTS as readonly string[]).includes(event));
  if (unknown.length > 0) {
    throw new ValidationError(`Unsupported webhook event(s): ${unknown.join(', ')}.`, { supported: SUPPORTED_EVENTS });
  }
  return events;
}

/** Re-exported so the controller can map a URL rejection onto a 422 without importing the class. */
export function asValidationError(error: unknown): unknown {
  return error instanceof WebhookSecurityError ? new ValidationError(error.message) : error;
}