/**
 * Microsoft Graph inbound provider (Phase 24.6 task 1).
 *
 * Two credential shapes are supported:
 * - client credentials (`GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`), the
 *   application-permission flow: a token is fetched from the login endpoint and cached in
 *   memory until it expires. Suitable for an app-only shared mailbox (`GRAPH_MAILBOX`).
 * - a static delegated access token (`GRAPH_ACCESS_TOKEN`), for operators who wired the
 *   mailbox through an external OAuth flow and inject the (short-lived) token via env.
 *
 * Sync uses Graph delta queries (`/users/{mailbox}/messages/delta`): the `@odata.deltaLink`
 * is stored as the per-connection cursor, so follow-up polls are incremental. The first poll
 * (no cursor) seeds the delta with a `receivedDateTime` floor; Graph's delta endpoint does
 * not accept filters, so it pages and the watermark filters client-side on the first run —
 * dedupe makes any overlap safe. Attachments are fetched per message through the attachments
 * endpoint and decoded from `contentBytes`.
 *
 * No network happens at construction: settings are validated in {@link parseGraphSettings}
 * (called at boot), and the token/message calls only run inside `poll()`.
 */
import { InboundMailError, type InboundMailMessage, type InboundMailProvider, type InboundPollOptions } from './index.js';
import type { MailAddress } from '../message/index.js';

export interface GraphSettings {
  tenantId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  accessToken: string | null;
  mailbox: string;
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function requiredString(raw: Record<string, string | undefined>, key: string): string {
  return (raw[key] ?? '').trim();
}

/** Parses `GRAPH_*` settings; called at boot so bad config fails before the first poll. */
export function parseGraphSettings(raw: Record<string, string | undefined>): GraphSettings {
  const tenantId = requiredString(raw, 'GRAPH_TENANT_ID') || null;
  const clientId = requiredString(raw, 'GRAPH_CLIENT_ID') || null;
  const clientSecret = requiredString(raw, 'GRAPH_CLIENT_SECRET') || null;
  const accessToken = requiredString(raw, 'GRAPH_ACCESS_TOKEN') || null;
  const mailbox = requiredString(raw, 'GRAPH_MAILBOX');
  if (mailbox === '') throw new InboundMailError('invalid_config', 'GRAPH_MAILBOX is required when MAIL_INBOUND_PROVIDER=graph.');
  const viaClientCredentials = tenantId !== null && clientId !== null && clientSecret !== null;
  if (!viaClientCredentials && accessToken === null) {
    throw new InboundMailError(
      'invalid_config',
      'Graph inbound needs either GRAPH_TENANT_ID + GRAPH_CLIENT_ID + GRAPH_CLIENT_SECRET or GRAPH_ACCESS_TOKEN.',
    );
  }
  return { tenantId, clientId, clientSecret, accessToken, mailbox };
}

export interface GraphFetchResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type GraphFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<GraphFetchResponse>;

function defaultFetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<GraphFetchResponse> {
  return (fetch as unknown as GraphFetch)(url, init);
}

interface DeltaCursor {
  deltaLink: string;
  watermark: string;
}

function decodeCursor(raw: string | null | undefined): DeltaCursor | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DeltaCursor>;
    if (typeof parsed['deltaLink'] === 'string') return { deltaLink: String(parsed['deltaLink']), watermark: String(parsed['watermark'] ?? '') };
  } catch {
    // Corrupted cursor: fall back to a watermark re-poll; dedupe makes it safe.
  }
  return null;
}

export class GraphInboundProvider implements InboundMailProvider {
  readonly name = 'graph';
  readonly configured = true;
  readonly connectionId: string;
  private cursorOut: string | null = null;
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private readonly fetchFn: GraphFetch;

  constructor(
    private readonly settings: GraphSettings,
    options: { connectionId?: string | undefined; fetch?: GraphFetch | undefined } = {},
  ) {
    this.connectionId = options.connectionId ?? `graph:${settings.mailbox}`;
    this.fetchFn = options.fetch ?? defaultFetch;
  }

  nextCursor(): string | null {
    return this.cursorOut;
  }

  async poll(options: InboundPollOptions = {}): Promise<InboundMailMessage[]> {
    const maxMessages = Math.max(1, Math.min(options.maxMessages ?? 50, 500));
    const stored = decodeCursor(options.cursor);
    const token = await this.accessToken();
    const base = `${GRAPH_BASE}/users/${encodeURIComponent(this.settings.mailbox)}/messages/delta`;
    const params = new URLSearchParams({
      $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,internetMessageHeaders,internetMessageId,conversationId,hasAttachments',
      $top: String(maxMessages),
    });
    let url = stored?.deltaLink ?? `${base}?${params.toString()}`;
    const response = await this.get(url, token);
    if (response.status === 401) {
      // A revoked/expired cached token is the classic transient failure: drop it and retry once.
      this.cachedToken = null;
      const fresh = await this.accessToken();
      url = stored?.deltaLink ?? `${base}?${params.toString()}`;
      const retry = await this.get(url, fresh);
      return this.normalizePage(retry, maxMessages);
    }
    return this.normalizePage(response, maxMessages);
  }

  private async normalizePage(response: GraphFetchResponse, maxMessages: number): Promise<InboundMailMessage[]> {
    if (response.status < 200 || response.status >= 300) {
      const text = await response.text().catch(() => '');
      void text;
      throw new InboundMailError('provider_error', `Microsoft Graph message fetch failed with status ${response.status}.`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const values = Array.isArray(payload['value']) ? (payload['value'] as Array<Record<string, unknown>>) : [];
    const deltaLink = typeof payload['@odata.deltaLink'] === 'string' ? String(payload['@odata.deltaLink']) : null;
    const token = await this.accessToken();
    const messages: InboundMailMessage[] = [];
    for (const value of values.slice(0, maxMessages)) {
      messages.push(await this.normalize(value, token));
    }
    // Persist the delta cursor together with a watermark: the cursor is the resume point, the
    // watermark is what a failure falls back to (Graph 410 Gone on an expired deltaLink).
    messages.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    const watermark = messages[messages.length - 1]?.receivedAt.toISOString() ?? new Date().toISOString();
    this.cursorOut = JSON.stringify({ deltaLink: deltaLink ?? '', watermark });
    return messages;
  }

  private async normalize(value: Record<string, unknown>, token: string): Promise<InboundMailMessage> {
    const body = (value['body'] as Record<string, unknown> | undefined) ?? {};
    const bodyContent = typeof body['content'] === 'string' ? String(body['content']) : '';
    const bodyType = typeof body['contentType'] === 'string' ? String(body['contentType']).toLowerCase() : 'text';
    const headers: Record<string, string> = {};
    const internetHeaders = value['internetMessageHeaders'];
    if (Array.isArray(internetHeaders)) {
      for (const entry of internetHeaders as Array<{ name?: string; value?: string }>) {
        if (typeof entry['name'] === 'string') headers[String(entry['name']).toLowerCase()] = String(entry['value'] ?? '');
      }
    }
    const attachments: Array<{ filename: string; contentType: string; cid: string | null; data: Buffer }> = [];
    if (value['hasAttachments'] === true && typeof value['id'] === 'string') {
      attachments.push(...(await this.fetchAttachments(String(value['id']), token)));
    }
    const providerMessageId = String(value['id'] ?? '');
    const received = new Date(String(value['receivedDateTime'] ?? new Date().toISOString()));
    const internetMessageId = typeof value['internetMessageId'] === 'string' ? String(value['internetMessageId']) : null;
    const conversationId = typeof value['conversationId'] === 'string' ? String(value['conversationId']) : null;
    return {
      providerMessageId,
      threadId: conversationId ?? internetMessageId,
      from: toAddress(value['from'] as Record<string, unknown> | undefined),
      to: toAddresses(value['toRecipients']),
      cc: toAddresses(value['ccRecipients']),
      subject: typeof value['subject'] === 'string' ? String(value['subject']) : '(no subject)',
      text: bodyType === 'html' ? String(value['bodyPreview'] ?? bodyContent) : bodyContent,
      html: bodyType === 'html' ? bodyContent : null,
      receivedAt: Number.isNaN(received.getTime()) ? new Date() : received,
      inReplyTo: headers['in-reply-to'] ?? null,
      headers,
      attachments,
      messageKind: classifyGraph(headers),
    };
  }

  private async fetchAttachments(messageId: string, token: string): Promise<Array<{ filename: string; contentType: string; cid: string | null; data: Buffer }>> {
    const url = `${GRAPH_BASE}/users/${encodeURIComponent(this.settings.mailbox)}/messages/${encodeURIComponent(messageId)}/attachments?$select=name,contentType,contentBytes`;
    const response = await this.get(url, token);
    if (response.status < 200 || response.status >= 300) return [];
    const payload = (await response.json()) as Record<string, unknown>;
    const values = Array.isArray(payload['value']) ? (payload['value'] as Array<Record<string, unknown>>) : [];
    const out: Array<{ filename: string; contentType: string; cid: string | null; data: Buffer }> = [];
    for (const entry of values) {
      const contentBytes = entry['contentBytes'];
      if (typeof contentBytes !== 'string') continue;
      out.push({
        filename: typeof entry['name'] === 'string' ? String(entry['name']) : 'attachment',
        contentType: typeof entry['contentType'] === 'string' ? String(entry['contentType']) : 'application/octet-stream',
        cid: null,
        data: Buffer.from(contentBytes, 'base64'),
      });
    }
    return out;
  }

  private async get(url: string, token: string): Promise<GraphFetchResponse> {
    return this.fetchFn(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  }

  private async accessToken(): Promise<string> {
    if (this.settings.accessToken !== null) return this.settings.accessToken;
    const now = Date.now();
    if (this.cachedToken !== null && this.cachedToken.expiresAt > now + 60_000) return this.cachedToken.value;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: String(this.settings.clientId),
      client_secret: String(this.settings.clientSecret),
      scope: 'https://graph.microsoft.com/.default',
    }).toString();
    let response: GraphFetchResponse;
    try {
      response = await this.fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(String(this.settings.tenantId))}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      throw new InboundMailError('provider_error', 'Microsoft Graph token request failed; check network and tenant settings.');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new InboundMailError('auth_failed', 'Microsoft Graph token request was rejected; check the app credentials.');
    }
    const payload = (await response.json()) as Record<string, unknown>;
    if (typeof payload['access_token'] !== 'string') {
      throw new InboundMailError('auth_failed', 'Microsoft Graph token response carried no access token.');
    }
    const expiresIn = typeof payload['expires_in'] === 'number' ? payload['expires_in'] : 3600;
    this.cachedToken = { value: String(payload['access_token']), expiresAt: now + Math.max(60, expiresIn) * 1000 };
    return this.cachedToken.value;
  }
}

function toAddress(entry: Record<string, unknown> | undefined): MailAddress {
  if (entry === undefined) return { name: null, address: 'unknown' };
  const email = entry['emailAddress'] as Record<string, unknown> | undefined;
  const address = typeof email?.['address'] === 'string' ? String(email['address']) : 'unknown';
  const name = typeof email?.['name'] === 'string' ? String(email['name']) : null;
  return { name, address };
}

function toAddresses(entry: unknown): MailAddress[] {
  if (!Array.isArray(entry)) return [];
  return (entry as Array<Record<string, unknown>>).map(toAddress);
}

function classifyGraph(headers: Record<string, string>): InboundMailMessage['messageKind'] {
  const from = (headers['from'] ?? '').toLowerCase();
  if (from.includes('mailer-daemon') || from.includes('postmaster@')) return 'bounce';
  if ((headers['auto-submitted'] ?? '').toLowerCase() !== '') return 'auto-reply';
  return 'standard';
}
