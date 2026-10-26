import { Inject, Injectable } from '@nestjs/common';

import type { ProviderCapability } from '../voice-communications/index.js';
import {
  VoiceCommunicationsSettingsService,
  VoiceProviderAccountsService,
} from '../voice-communications/index.js';
import { OmnichannelSettingsService } from './omnichannel-settings.service.js';

/**
 * Phase 19-OM.4 — the adapter/capability registry the workspace reads
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.2` capability lookup; feature contract §2.1, §11;
 * feasibility records CF-1/CF-2/CF-4).
 *
 * Channel availability is a computed answer, never a hard-coded assumption (plan §4.1): it reads
 * the Voice registry's declared capabilities, the bound accounts' *granted ∩ declared* effective
 * capabilities, the owning module's feature flags and this module's own switch. A capability that
 * is not declared is reported absent — the composer must then refuse it as `unsupported` (E3),
 * not silently succeed (contract §9). Only the exported barrel surface of `VoiceCommunications` is
 * used (E1) — no deep import and no provider SDK type crosses into Omnichannel (acceptance: "core
 * conversation services do not import provider SDK types").
 *
 * Versioning: the view carries `catalogVersion`. Additive changes (a new channel row, a new
 * capability field) bump the minor; removing a row or re-typing a field is a breaking change the
 * contract forbids without a recorded decision.
 */

export const OMNICHANNEL_CAPABILITY_CATALOG_VERSION = 1;

export type OmnichannelChannelKey = 'sms' | 'whatsapp' | 'mms' | 'web_chat' | 'voice';

export interface OmnichannelChannelCapabilityView {
  readonly channel: OmnichannelChannelKey;
  /** Which module carries the transport: VoiceCommunications (D1) or the module's own widget (OM.9). */
  readonly transport: 'voice' | 'self';
  /**
   * 19-OM.14 — whether an adapter actually implements this channel. MMS is vocabulary, not a
   * capability: no adapter declares it (CF-5), so it is reported unsupported and every MMS request
   * answers `unsupported` — never a silent success and never a hidden failure.
   */
  readonly supported: boolean;
  /** The owning module's feature flag for this channel. */
  readonly enabled: boolean;
  /** Whether a usable transport actually exists right now (bound account, or shipped widget). */
  readonly configured: boolean;
  readonly inbound: boolean;
  readonly outbound: boolean;
  readonly deliveryStatuses: boolean;
  readonly readReceipts: boolean;
  readonly templates: boolean;
  readonly media: boolean;
  /** The non-secret account identity behind the answer, so the UI can explain itself. */
  readonly accounts: readonly { readonly key: string; readonly label: string }[];
  /** Stable, human-readable limits — why a capability is off, not a silent boolean. */
  readonly notes: readonly string[];
}

export interface OmnichannelCapabilityCatalog {
  readonly catalogVersion: number;
  readonly channels: readonly OmnichannelChannelCapabilityView[];
}

@Injectable()
export class OmnichannelCapabilityService {
  constructor(
    @Inject(VoiceProviderAccountsService) private readonly accounts: VoiceProviderAccountsService,
    @Inject(VoiceCommunicationsSettingsService) private readonly voiceSettings: VoiceCommunicationsSettingsService,
    @Inject(OmnichannelSettingsService) private readonly settings: OmnichannelSettingsService,
  ) {}

  async catalog(): Promise<OmnichannelCapabilityCatalog> {
    const [views, voiceSettings, omnichannelSettings] = await Promise.all([
      this.accounts.list(),
      this.voiceSettings.settings(),
      this.settings.settings(),
    ]);
    const usable = views.filter((account) => account.enabled);
    const workspace = omnichannelSettings.features.workspace;

    const channels: OmnichannelChannelCapabilityView[] = [
      this.voiceChannel('sms', usable, voiceSettings.features.sms, 'messaging.sms.send', 'messaging.sms.receive'),
      this.voiceChannel('whatsapp', usable, voiceSettings.features.whatsapp, 'messaging.whatsapp.send', 'messaging.whatsapp.receive'),
      this.unsupportedChannel('mms', 'MMS is named in the vocabulary but no adapter declares send/receive (CF-5); requests answer `unsupported`.'),
      this.webChatChannel(workspace, omnichannelSettings.webChat),
      // 19-OM.13 — calls are context, not conversations: reported so a disabled/broken voice
      // connector is visible honestly, without affecting any messaging row.
      this.callsChannel(usable, voiceSettings.features.voice),
    ];
    return { catalogVersion: OMNICHANNEL_CAPABILITY_CATALOG_VERSION, channels };
  }

  private voiceChannel(
    channel: Extract<OmnichannelChannelKey, 'sms' | 'whatsapp'>,
    usable: readonly { key: string; label: string; effectiveCapabilities: readonly ProviderCapability[] }[],
    featureEnabled: boolean,
    sendKey: ProviderCapability,
    receiveKey: ProviderCapability,
  ): OmnichannelChannelCapabilityView {
    const bound = usable.filter(
      (account) => account.effectiveCapabilities.includes(sendKey) || account.effectiveCapabilities.includes(receiveKey),
    );
    const granted = new Set<ProviderCapability>(bound.flatMap((account) => [...account.effectiveCapabilities]));
    const notes: string[] = [];
    if (!featureEnabled) notes.push('The owning Voice module has this channel switched off.');
    if (bound.length === 0) notes.push('No enabled account grants this channel; sends are refused until one exists.');
    if (!granted.has('messaging.media')) notes.push('Media is not declared by any bound adapter — requests answer `unsupported` (CF-2).');
    if (channel === 'whatsapp') notes.push('Outside the customer-service window only approved templates are sendable (CF-2).');
    // The transport vocabulary has no read-receipt capability key; reporting it as supported without
    // a declaration is exactly the "assumed provider support" OM.1 exists to prevent.
    return {
      channel,
      transport: 'voice',
      supported: true,
      enabled: featureEnabled,
      configured: bound.length > 0,
      inbound: granted.has(receiveKey),
      outbound: granted.has(sendKey),
      deliveryStatuses: granted.has('messaging.deliveryStatus'),
      readReceipts: false,
      templates: channel === 'whatsapp' && granted.has('messaging.templates'),
      media: granted.has('messaging.media'),
      accounts: bound.map((account) => ({ key: account.key, label: account.label })),
      notes,
    };
  }

  private callsChannel(
    usable: readonly { key: string; label: string; effectiveCapabilities: readonly ProviderCapability[] }[],
    featureEnabled: boolean,
  ): OmnichannelChannelCapabilityView {
    const bound = usable.filter(
      (account) => account.effectiveCapabilities.includes('voice.inboundEvents') || account.effectiveCapabilities.includes('voice.outboundCall'),
    );
    const granted = new Set<ProviderCapability>(bound.flatMap((account) => [...account.effectiveCapabilities]));
    const notes: string[] = ['Calls are shown as context; they are not conversations (contract §4).'];
    if (!featureEnabled) notes.push('The owning Voice module has the voice channel switched off.');
    if (bound.length === 0) notes.push('No enabled account grants voice; call context is unavailable.');
    return {
      channel: 'voice',
      transport: 'voice',
      supported: true,
      enabled: featureEnabled,
      configured: bound.length > 0,
      inbound: granted.has('voice.inboundEvents'),
      outbound: granted.has('voice.outboundCall'),
      deliveryStatuses: granted.has('voice.callStatusCallbacks'),
      readReceipts: false,
      templates: false,
      media: granted.has('voice.recordingDownload'),
      accounts: bound.map((account) => ({ key: account.key, label: account.label })),
      notes,
    };
  }

  /** A channel this build names but no adapter implements: reported, never offered. */
  private unsupportedChannel(channel: OmnichannelChannelKey, note: string): OmnichannelChannelCapabilityView {
    return {
      channel,
      transport: 'voice',
      supported: false,
      enabled: false,
      configured: false,
      inbound: false,
      outbound: false,
      deliveryStatuses: false,
      readReceipts: false,
      templates: false,
      media: false,
      accounts: [],
      notes: [note],
    };
  }

  private webChatChannel(
    workspaceEnabled: boolean,
    webChat: { readonly enabled: boolean; readonly allowedOrigins: readonly string[] },
  ): OmnichannelChannelCapabilityView {
    // 19-OM.9: the self-hosted widget. "Configured" is stricter than "enabled": a browser client is
    // refused until the operator names at least one allowed origin (fail closed, contract §7).
    const enabled = workspaceEnabled && webChat.enabled;
    const configured = enabled && webChat.allowedOrigins.length > 0;
    const notes: string[] = [];
    if (!webChat.enabled) notes.push('Website chat is switched off in the Omnichannel settings.');
    else if (webChat.allowedOrigins.length === 0) notes.push('No allowed origin is configured; browser widgets are refused.');
    if (!workspaceEnabled) notes.push('The Omnichannel workspace is switched off.');
    return {
      channel: 'web_chat',
      transport: 'self',
      supported: true,
      enabled,
      configured,
      inbound: enabled,
      outbound: enabled,
      deliveryStatuses: false,
      readReceipts: false,
      templates: false,
      media: false,
      accounts: [],
      notes,
    };
  }
}
