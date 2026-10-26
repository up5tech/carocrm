import { Inject, Injectable, Optional } from '@nestjs/common';

import type { MessageChannel } from '../../voice-communications/index.js';
import { VoiceInboxService , VoiceMessagingService } from '../../voice-communications/index.js';
import { VoiceConsentService } from '../../voice-communications/voice-consent.service.js';
import { IntegrationContractRegistry } from '../integration-contracts.js';

/**
 * Phase 19-INT.25 — the `VoiceCommunications` contract
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14.2, §19 `19-INT.25`).
 *
 * `VoiceCommunications` owns communication delivery, and with it the opt-outs: a person who asked
 * a number not to be called must not be called by anything, including a connector.
 *
 * The contract therefore does one thing: it records a **suppression** on the channel and address
 * the provider reported. It does not send anything, and it does not decide that a message is
 * deliverable — that is the owner's job.
 *
 * The contract is optional: a deployment without `VoiceCommunications` publishes none of it.
 */

/** The input of the voice suppression contract. */
export interface VoiceSuppressionInput {
  /** The channel the provider reported, e.g. `sms` or `voice`. */
  readonly channel: string;
  /** The address the provider reported. */
  readonly address: string;
  /** Why the provider blocked the address. */
  readonly reason: string;
  /** The provider's key, e.g. `mailchimp`. */
  readonly provider?: string | undefined;
}

export interface VoiceSuppressionOutput {
  readonly id: string;
  readonly channel: string;
  readonly address: string;
  readonly reason: string;
}

/**
 * Phase 19-OM.4 (extension E14) — the inbox/read contract.
 *
 * The consumer sees exactly what the Voice inbox API sees: the read runs under the acting user's
 * ACL inside `VoiceInboxService` (the owner's check is not bypassed), and the answer is the
 * owner's projection, not a copy. `conversationId` returns that conversation's timeline (with the
 * owner's internal notes — a consumer must not expose them on a customer surface); without it, the
 * conversation list.
 */
export interface VoiceInboxReadInput {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly status?: string | undefined;
  readonly channel?: string | undefined;
  readonly conversationId?: string | undefined;
}

export interface VoiceInboxReadOutput {
  readonly total: number;
  readonly conversations: readonly Record<string, unknown>[];
  readonly entries?: readonly Record<string, unknown>[] | undefined;
}

/**
 * Phase 19-OM.4 (extension E14) — the message/send contract.
 *
 * Requesting a send means entering the owner's pipeline with it: policy, consent, suppression,
 * quiet hours, template/window rules, the idempotency key and the recorded state machine all run
 * inside `VoiceMessagingService` exactly as they do for the Voice inbox. The output is what the
 * owner recorded, never an assumed provider truth. A consumer must present a human principal or the
 * documented service scope — this contract adds no authority of its own.
 */
export interface VoiceMessageSendInput {
  readonly channel: 'sms' | 'mms' | 'whatsapp';
  readonly body: string;
  readonly idempotencyKey: string;
  readonly accountKey?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly to?: string | undefined;
  readonly purpose?: string | undefined;
  readonly templateKey?: string | undefined;
  readonly templateLanguage?: string | undefined;
  readonly templateVariables?: Readonly<Record<string, string>> | undefined;
  readonly isInternalNote?: boolean | undefined;
}

export interface VoiceMessageSendOutput {
  readonly messageId: string;
  readonly state: string;
  readonly duplicate: boolean;
}

@Injectable()
export class VoiceCommunicationsIntegrationContracts {
  constructor(
    @Inject(IntegrationContractRegistry) private readonly registry: IntegrationContractRegistry,
    @Optional() @Inject(VoiceConsentService) private readonly consent: VoiceConsentService | null,
    @Optional() @Inject(VoiceInboxService) private readonly inbox: VoiceInboxService | null,
    @Optional() @Inject(VoiceMessagingService) private readonly messaging: VoiceMessagingService | null,
  ) {
    if (this.consent !== null) {
      this.registry.register<VoiceSuppressionInput, VoiceSuppressionOutput>({
        contractKey: 'voiceCommunications.consent.suppress',
        contractVersion: 1,
        owningModule: 'VoiceCommunications',
        ownership:
          'Communication delivery and the opt-out list. A connector may report that an address must not be contacted; it may not send anything and it may not deliver a message.',
        apply: async (input) => {
          const consent = this.consent;
          if (consent === null) throw new Error('The Voice Communications module is not available.');
          const view = await consent.suppress({
            channel: input.channel as never,
            address: input.address,
            reason: input.reason as never,
            source: 'provider_webhook',
          });
          return {
            value: {
              id: view.id,
              channel: view.channel,
              address: view.address,
              reason: view.reason,
            },
            affectedRecords: [],
          };
        },
      });
    }

    // E14 — the transport surface Omnichannel (and any other kernel module) consumes. Reading runs
    // through the owner's ACL; sending runs through the owner's full policy/consent/idempotency
    // pipeline. Neither adds authority, and neither returns a credential or a raw provider body.
    if (this.inbox !== null) {
      this.registry.register<VoiceInboxReadInput, VoiceInboxReadOutput>({
        contractKey: 'voiceCommunications.inbox.read',
        contractVersion: 1,
        owningModule: 'VoiceCommunications',
        ownership:
          'The canonical conversation and message records (D1). A consumer may read what the acting user may read and never maintains a second conversation store.',
        apply: async (input) => {
          const inbox = this.inbox;
          if (inbox === null) throw new Error('The Voice Communications module is not available.');
          if (input.conversationId !== undefined && input.conversationId !== '') {
            const page = await inbox.timeline(input.conversationId, {
              limit: clampPage(input.limit, 50),
              offset: clampOffset(input.offset),
            });
            return {
              value: { total: page.entries.length, conversations: [], entries: page.entries as unknown as Record<string, unknown>[] },
              affectedRecords: [{ entityType: 'CommunicationConversation', entityId: input.conversationId }],
            };
          }
          const page = await inbox.list({
            limit: clampPage(input.limit, 25),
            offset: clampOffset(input.offset),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.channel === undefined ? {} : { channel: input.channel }),
          });
          return {
            value: {
              total: page.total,
              conversations: page.list as unknown as Record<string, unknown>[],
            },
            affectedRecords: [],
          };
        },
      });
    }

    if (this.messaging !== null) {
      this.registry.register<VoiceMessageSendInput, VoiceMessageSendOutput>({
        contractKey: 'voiceCommunications.message.send',
        contractVersion: 1,
        owningModule: 'VoiceCommunications',
        ownership:
          'Outbound transport. The owner enforces policy, consent, suppression, quiet hours, template/window rules and idempotency; a consumer requests a send and never records a competing delivery state.',
        apply: async (input) => {
          const messaging = this.messaging;
          if (messaging === null) throw new Error('The Voice Communications module is not available.');
          const result = await messaging.send({
            channel: input.channel as MessageChannel,
            body: input.body,
            idempotencyKey: input.idempotencyKey,
            ...(input.accountKey === undefined ? {} : { accountKey: input.accountKey }),
            ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
            ...(input.to === undefined ? {} : { to: input.to }),
            ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
            ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
            ...(input.templateLanguage === undefined ? {} : { templateLanguage: input.templateLanguage }),
            ...(input.templateVariables === undefined ? {} : { templateVariables: input.templateVariables }),
            ...(input.isInternalNote === undefined ? {} : { isInternalNote: input.isInternalNote }),
          });
          return {
            value: { messageId: result.message.id, state: result.message.state, duplicate: result.duplicate },
            affectedRecords: [{ entityType: 'CommunicationMessage', entityId: result.message.id }],
          };
        },
      });
    }
  }

  /** The contracts this module publishes. Used by the diagnostics. */
  static readonly publishedContractKeys: readonly string[] = [
    'voiceCommunications.consent.suppress',
    'voiceCommunications.inbox.read',
    'voiceCommunications.message.send',
  ];
}

function clampPage(value: number | undefined, fallback: number): number {
  const wanted = Math.trunc(value ?? fallback);
  return Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, 100) : fallback;
}

function clampOffset(value: number | undefined): number {
  const wanted = Math.trunc(value ?? 0);
  return Number.isFinite(wanted) && wanted > 0 ? wanted : 0;
}
