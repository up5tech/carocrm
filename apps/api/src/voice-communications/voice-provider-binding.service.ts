import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";

import { VoiceProviderRegistry } from "./voice-provider.js";
import { AsteriskProviderAdapter } from "./voice-provider-asterisk.js";
import { TwilioProviderAdapter } from "./voice-provider-twilio.js";

/**
 * Registers the production adapters once at module start, following the
 * `MarketingProviderBindingService` precedent (`PLAN_Phase_19_Voice_Communications.md` §6.3).
 *
 * Registration is code, not data: an operator can configure an account, but cannot install an
 * adapter at runtime, and a provider that was removed from this list fails closed to `none` while
 * its account remains visible for diagnosis.
 */
@Injectable()
export class VoiceProviderBindingService implements OnModuleInit {
  constructor(@Inject(VoiceProviderRegistry) private readonly registry: VoiceProviderRegistry) {}

  onModuleInit(): void {
    this.registry.register(new TwilioProviderAdapter());
    this.registry.register(new AsteriskProviderAdapter());
  }
}
