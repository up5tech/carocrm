/**
 * Email module barrel (PLAN §28) — integrator entry point.
 *
 * Wire into AppModule:
 *   controllers: [...EMAIL_CONTROLLERS]   // before ENTITY_CONTROLLERS: `Email`/`EmailTemplate` are static prefixes
 *   providers:   [...EMAIL_PROVIDERS]
 *
 * Needs CONFIG_TOKEN, DatabaseService, REQUEST_SCOPE_TOKEN, EntityCrudService, AclApiService and
 * JobsService from the host module. `MAIL_TRANSPORT_TOKEN` is the seam: an extension can replace it
 * with SES/SendGrid/Graph later without touching this module.
 */
import type { InboundMailProvider, MailTransport } from '@carocrm/mail';
import { createInboundProvider,createMailTransport,NullInboundProvider } from '@carocrm/mail';
import type { Provider, Type } from '@nestjs/common';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { INBOUND_MAIL_PROVIDER_TOKEN, MAIL_TRANSPORT_TOKEN } from './email.constants.js';
import { EmailController } from './email.controller.js';
import { EmailService } from './email.service.js';
import { EmailAccountController } from './email-account.controller.js';
import { EmailAccountsService } from './email-accounts.service.js';
import { EmailTemplateController } from './email-template.controller.js';
import { EmailTemplatePreviewService } from './email-template-preview.service.js';
import { InboundConnectionsService } from './inbound-connections.service.js';

export {
  DELIVERY_STATUSES,
  EMAIL_ENTITY,
  EMAIL_STATUSES,
  EMAIL_TEMPLATE_ENTITY,
  INBOUND_MAIL_PROVIDER_TOKEN,
  MAIL_TRANSPORT_TOKEN,
  SEND_EMAIL_JOB,
  SENDABLE_STATUSES,
} from './email.constants.js';
export { EmailController } from './email.controller.js';
export type { EmailDeliveryView, QueuedEmail } from './email.service.js';
export { EmailService } from './email.service.js';
export { EmailAccountController } from './email-account.controller.js';
export { EmailAccountsService } from './email-accounts.service.js';
export { EmailTemplateController } from './email-template.controller.js';
export {
  type EmailTemplatePreview,
  EmailTemplatePreviewService,
  PREVIEW_SAMPLE_ENTITIES,
} from './email-template-preview.service.js';
export { InboundConnectionsService } from './inbound-connections.service.js';
export type { MailTransportInfo } from '@carocrm/mail';

/**
 * Build the transport from `MAIL_TRANSPORT` plus the `SMTP_*` / `MAIL_MAX_RECIPIENTS` settings.
 * `parseSmtpSettings` runs here, so an `smtp` mode without a host fails at boot instead of on the
 * first send.
 */
export function createMailTransportFromConfig(config: AppConfig, env: NodeJS.ProcessEnv = process.env): MailTransport {
  return createMailTransport(config.mailTransport, env);
}

/**
 * Build the inbound provider selected by `MAIL_INBOUND_PROVIDER` (Phase 24.6). The `none`
 * default binds `NullInboundProvider`, whose `poll()` fails clearly instead of pretending to
 * collect mail. Settings are parsed eagerly, so a bad `imap`/`graph` config fails at boot.
 */
export function createInboundProviderFromConfig(config: AppConfig, env: NodeJS.ProcessEnv = process.env): InboundMailProvider {
  if (config.mailInboundProvider === 'none') return new NullInboundProvider();
  return createInboundProvider(config.mailInboundProvider, env as Record<string, string | undefined>);
}

export const EMAIL_PROVIDERS: Provider[] = [
  {
    provide: MAIL_TRANSPORT_TOKEN,
    inject: [CONFIG_TOKEN],
    useFactory: (config: AppConfig) => createMailTransportFromConfig(config),
  },
  // Phase 24.6: the provider is bound by MAIL_INBOUND_PROVIDER (default: none, fails clearly).
  {
    provide: INBOUND_MAIL_PROVIDER_TOKEN,
    inject: [CONFIG_TOKEN],
    useFactory: (config: AppConfig) => createInboundProviderFromConfig(config),
  },
  EmailAccountsService,
  InboundConnectionsService,
  EmailService,
  EmailTemplatePreviewService,
];

export const EMAIL_CONTROLLERS: Type<unknown>[] = [EmailAccountController, EmailController, EmailTemplateController];
