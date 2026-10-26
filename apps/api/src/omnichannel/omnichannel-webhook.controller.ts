import { NotFoundError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/auth.guard.js';
import { VoiceWebhookIngressService } from '../voice-communications/index.js';

/**
 * Phase 19-OM.5 — the Omnichannel webhook ingress route
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.5`; feature contract §3 F6; decision D1).
 *
 * `POST /api/v1/integrations/omnichannel/{providerKey}/{accountKey}/{kind}` with
 * `kind ∈ voice-events | message-events | status-events | media-events`.
 *
 * This is the plan's *"reuse an existing shared webhook ingestion service"* option, taken literally:
 * the whole security contract — account resolution, body ceiling, replay window, adapter-owned
 * signature validation, the durable deduplicated receipt in `voice_webhook_events`, the fast
 * `202`, the asynchronous job, and the admin-gated replay — lives in
 * `VoiceWebhookIngressService` and runs unchanged. This controller adds one thing only: Omnichannel
 * deployments can point a provider at the module's own callback prefix without creating a second
 * receipt store or a second normalization path (plan §0.1/§2.4; R1). The two prefixes are aliases
 * over one pipeline; a provider URL is configuration, not architecture.
 *
 * Unauthenticated by design — a provider cannot hold a CRM session; authentication is the
 * provider's own signature, verified by the adapter before any effect. `{accountKey}` is a routing
 * identifier, never a secret. `bootstrap.ts` preserves the exact request bytes for this prefix
 * (extension E2) and they reach the adapter through the shared ingress contract, so a future
 * byte-signing provider (19-OM.15) verifies what Twilio-style reconstruction cannot.
 */

const WEBHOOK_KINDS = new Set(['voice-events', 'message-events', 'status-events', 'media-events']);

@ApiTags('omnichannel')
@Controller('api/v1/integrations/omnichannel')
export class OmnichannelWebhookController {
  constructor(@Inject(VoiceWebhookIngressService) private readonly ingress: VoiceWebhookIngressService) {}

  @Public()
  @HttpCode(202)
  @Post(':providerKey/:accountKey/:kind')
  async receive(
    @Param('providerKey') providerKey: string,
    @Param('accountKey') accountKey: string,
    @Param('kind') kind: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @Req() request: { readonly url?: string | undefined; readonly protocol?: string | undefined; readonly rawBody?: string | null | undefined },
  ) {
    if (!WEBHOOK_KINDS.has(kind)) {
      throw new NotFoundError(`Unknown webhook kind "${kind}".`);
    }
    const payload = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
    const url = absoluteCallbackUrl(request, headers);
    const rawBody = request.rawBody;
    return this.ingress.ingest({
      providerKey,
      accountKey,
      headers,
      body: payload,
      ...(url === undefined ? {} : { url }),
      ...(typeof rawBody === 'string' && rawBody !== '' ? { rawBody } : {}),
    });
  }
}

/**
 * URL-signing providers sign the absolute callback URL; Fastify's `request.url` is a path, so the
 * public origin is reconstructed from forwarded headers. A wrong URL can only fail a signature
 * check, never bypass one. (Same documented rule as the Voice controller; an operator can pin the
 * exact value on the account's `webhookUrl` instead.)
 */
function absoluteCallbackUrl(
  request: { readonly url?: string | undefined; readonly protocol?: string | undefined },
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const path = request.url;
  if (path === undefined || path.trim() === '') return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  const forwardedProto = firstHeaderValue(headers['x-forwarded-proto']);
  const protocol = forwardedProto ?? request.protocol ?? 'https';
  const host = firstHeaderValue(headers['x-forwarded-host']) ?? firstHeaderValue(headers.host);
  return host === undefined ? path : `${protocol}://${host}${path}`;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(',')[0]?.trim();
  return first === undefined || first === '' ? undefined : first;
}
