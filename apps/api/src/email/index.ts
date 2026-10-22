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
import { createMailTransport,NullInboundProvider } from '@carocrm/mail';
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
export { EmailAccountsService, type EmailAccountView } from './email-accounts.service.js';
export { EmailTemplateController } from './email-template.controller.js';
export {
  type EmailTemplatePreview,
  EmailTemplatePreviewService,
  PREVIEW_SAMPLE_ENTITIES,
} from './email-template-preview.service.js';
export type { MailTransportInfo } from '@carocrm/mail';

/**
 * Build the transport from `MAIL_TRANSPORT` plus the `SMTP_*` / `MAIL_MAX_RECIPIENTS` settings.
 * `parseSmtpSettings` runs here, so an `smtp` mode without a host fails at boot instead of on the
 * first send.
 */
export function createMailTransportFromConfig(config: AppConfig, env: NodeJS.ProcessEnv = process.env): MailTransport {
  return createMailTransport(config.mailTransport, env);
}

export const EMAIL_PROVIDERS: Provider[] = [
  {
    provide: MAIL_TRANSPORT_TOKEN,
    inject: [CONFIG_TOKEN],
    useFactory: (config: AppConfig) => createMailTransportFromConfig(config),
  },
  // §28.2: a null provider until an IMAP/Graph adapter is installed — polling stays a safe no-op.
  {
    provide: INBOUND_MAIL_PROVIDER_TOKEN,
    useFactory: (): InboundMailProvider => new NullInboundProvider(),
  },
  EmailAccountsService,
  EmailService,
  EmailTemplatePreviewService,
];

export const EMAIL_CONTROLLERS: Type<unknown>[] = [EmailAccountController, EmailController, EmailTemplateController];
