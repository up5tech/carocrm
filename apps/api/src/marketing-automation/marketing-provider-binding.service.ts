import type { MailTransport } from "@carocrm/mail";
import type { OnModuleInit } from "@nestjs/common";
import { Inject, Injectable, Optional } from "@nestjs/common";

import { MAIL_TRANSPORT_TOKEN } from "../email/email.constants.js";
import { EmailAccountsService } from "../email/email-accounts.service.js";
import { MarketingProviderRegistry } from "./marketing-automation-provider.js";
import { createKernelMailProvider } from "./marketing-provider-kernel.adapter.js";

/**
 * Phase 19-MA.7 — bind the live provider at bootstrap (§7.1 `MarketingProviderRegistry`, §15 `19-MA.7` task 1).
 *
 * The registry resolves adapters by key and knows nothing about the platform's mail layer; this one-place
 * registration is what makes `platform-mail` resolvable. It is a module-lifecycle step rather than a
 * constructor side effect for the same reason the write guard registers hooks at bootstrap: the ordering is
 * explicit and an integrator can see exactly what this module attaches to the running system.
 *
 * Both dependencies are optional on purpose. A deployment without the email barrel (or a test root module
 * that installs only this module) gets a working registry whose `platform-mail` key resolves to `disabled` —
 * fail closed, never a crash and never an accidental live send (§1.2, §15 acceptance "unit/E2E tests cannot
 * accidentally use a live provider").
 */
@Injectable()
export class MarketingProviderBindingService implements OnModuleInit {
  constructor(
    @Inject(MarketingProviderRegistry) private readonly registry: MarketingProviderRegistry,
    @Optional() @Inject(MAIL_TRANSPORT_TOKEN) private readonly transport?: MailTransport,
    @Optional() @Inject(EmailAccountsService) private readonly accounts?: EmailAccountsService,
  ) {}

  onModuleInit(): void {
    if (this.transport === undefined || this.accounts === undefined) return;
    this.registry.register(createKernelMailProvider(this.transport, this.accounts));
  }
}
