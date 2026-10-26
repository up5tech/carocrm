import { Inject, Injectable } from '@nestjs/common';

import {
  type NormalizedProviderEvent,
  type ProviderHealthResult,
  type ProviderSendMessageInput,
  type ProviderSendMessageResult,
  type ProviderWebhookRequest,
  type ResolvedProviderAccount,
  type ValidatedProviderEvent,
  type VoiceProviderAdapter,
  VoiceProviderError,
  VoiceProviderRegistry,
} from '../voice-communications/index.js';

/**
 * Phase 19-OM.9 — the website-chat transport (contract §7; decision D1).
 *
 * The widget is served by this application, so the "provider" is the CRM itself: there is no network
 * call, no credential and no webhook. The adapter exists so the channel speaks the same
 * `VoiceProviderAdapter` contract every other channel does (OM.4/E15: transport goes through Voice's
 * adapter, never a direct write from a conversation controller): `sendMessage` records an accepted,
 * sent message (delivery is the visitor reading it through the public endpoint), and every inbound
 * visitor message enters through `VoiceMessagingService.ingestInbound` exactly like an SMS.
 *
 * It is registered into `VoiceProviderRegistry` by the Omnichannel module at bootstrap and backs the
 * single seeded account `omnichannel-web-chat` (migration 079).
 */

export const OMNICHANNEL_WEB_CHAT_PROVIDER_KEY = 'omnichannel-web-chat';
export const OMNICHANNEL_WEB_CHAT_ACCOUNT_KEY = 'omnichannel-web-chat';

export class OmnichannelWebChatAdapter implements VoiceProviderAdapter {
  readonly info = {
    key: OMNICHANNEL_WEB_CHAT_PROVIDER_KEY,
    label: 'Website chat (self-hosted)',
    mode: 'live' as const,
    capabilities: ['messaging.web_chat.send', 'messaging.web_chat.receive'] as const,
    channels: ['web_chat'] as const,
    ratePerMinute: 0,
    maxConcurrency: 1,
    webhookSignature: 'none' as const,
  };

  hasCapability(capability: Parameters<VoiceProviderAdapter['hasCapability']>[0]): boolean {
    return (this.info.capabilities as readonly string[]).includes(capability);
  }

  async validateWebhook(_request: ProviderWebhookRequest, _account: ResolvedProviderAccount): Promise<ValidatedProviderEvent> {
    // The widget is not a provider callback: there is no signature scheme to authenticate.
    throw new VoiceProviderError('unsupported', 'The website chat channel has no provider webhooks.');
  }

  normalizeEvent(): NormalizedProviderEvent {
    return { kind: 'unknown', reason: 'website chat has no provider webhooks', occurredAt: null };
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      detail: 'The website chat transport is served by this application; there is no provider to check.',
    };
  }

  async sendMessage(input: ProviderSendMessageInput): Promise<ProviderSendMessageResult> {
    if (input.body.trim() === '') {
      throw new VoiceProviderError('invalid_request', 'A website chat message needs text.');
    }
    return {
      // Deterministic per message row: the widget deduplicates on it as well as on the row id.
      providerMessageId: `webchat:${input.messageId}`,
      accepted: true,
      // The visitor reads the message through the public endpoint; claiming `delivered` would be a
      // delivery claim without evidence (plan §0.1).
      state: 'sent',
    };
  }
}

/**
 * Registration seam: constructing this provider installs the adapter into the shared registry, so
 * the seeded account resolves and the agent reply path works with no special-casing.
 */
@Injectable()
export class OmnichannelWebChatTransport {
  constructor(@Inject(VoiceProviderRegistry) registry: VoiceProviderRegistry) {
    registry.register(new OmnichannelWebChatAdapter());
  }
}
