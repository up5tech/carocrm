import { NotFoundError } from "@carocrm/core/errors/index.js";
import { Body, Controller, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/auth.guard.js";
import { VoiceWebhookIngressService } from "./voice-webhook-ingress.service.js";

/**
 * Phase 19-VC.5 — provider webhook ingress
 * (`PLAN_Phase_19_Voice_Communications.md` §11.4, §15 `19-VC.5`).
 *
 * `POST /api/v1/integrations/voice-communications/{providerKey}/{accountKey}/{kind}` with
 * `kind ∈ voice-events | message-events | status-events | media-events` (`media-events` carries
 * recording callbacks, 19-VC.15).
 *
 * Unauthenticated by design: a provider cannot hold a CRM session. Authentication is the provider's
 * own signature, verified by the adapter before any effect occurs (§13.2). `accountKey` is a routing
 * identifier, never a secret — publishing it grants nothing.
 *
 * The response is deliberately thin (`202` + receipt id + duplicate flag): a provider learns that the
 * callback was recorded, not whether the address is a customer. Processing happens in a job.
 */
@ApiTags("voice-communications")
@Controller("api/v1/integrations/voice-communications")
export class VoiceWebhookController {
  constructor(@Inject(VoiceWebhookIngressService) private readonly ingress: VoiceWebhookIngressService) {}

  @Public()
  @HttpCode(202)
  @Post(":providerKey/:accountKey/:kind")
  async receive(
    @Param("providerKey") providerKey: string,
    @Param("accountKey") accountKey: string,
    @Param("kind") kind: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    if (!WEBHOOK_KINDS.has(kind)) {
      throw new NotFoundError(`Unknown webhook kind "${kind}".`);
    }
    const payload = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
    return this.ingress.ingest({ providerKey, accountKey, headers, body: payload });
  }
}

const WEBHOOK_KINDS = new Set(["voice-events", "message-events", "status-events", "media-events"]);
