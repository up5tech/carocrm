/**
 * Email module barrel (PLAN §28) — integrator entry point.
 *
 * Wire into AppModule:
 *   controllers: [...EMAIL_CONTROLLERS]   // before ENTITY_CONTROLLERS: `Email` is a static prefix
 *   providers:   [...EMAIL_PROVIDERS]
 *
 * Needs CONFIG_TOKEN, DatabaseService, REQUEST_SCOPE_TOKEN, EntityCrudService, AclApiService and
 * JobsService from the host module. `MAIL_TRANSPORT_TOKEN` is the seam: an extension can replace it
 * with SES/SendGrid/Graph later without touching this module.
 */
import type { MailTransport } from '@carocrm/mail';
import { createMailTransport } from '@carocrm/mail';
import type { Provider, Type } from '@nestjs/common';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { MAIL_TRANSPORT_TOKEN } from './email.constants.js';
import { EmailController } from './email.controller.js';
import { EmailService } from './email.service.js';

export {
  DELIVERY_STATUSES,
  EMAIL_ENTITY,
  EMAIL_STATUSES,
  MAIL_TRANSPORT_TOKEN,
  SEND_EMAIL_JOB,
  SENDABLE_STATUSES,
} from './email.constants.js';
export { EmailController } from './email.controller.js';
export type { EmailDeliveryView, QueuedEmail } from './email.service.js';
export { EmailService } from './email.service.js';
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
  EmailService,
];

export const EMAIL_CONTROLLERS: Type<unknown>[] = [EmailController];
