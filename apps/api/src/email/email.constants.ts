/**
 * Email module constants (PLAN §28).
 *
 * `MAIL_TRANSPORT_TOKEN` is the seam: the barrel builds it from `MAIL_TRANSPORT`, and an extension
 * can replace it with SES/SendGrid/Graph later without touching this module.
 */
export const MAIL_TRANSPORT_TOKEN = Symbol('MAIL_TRANSPORT');

/** The metadata entity that stores an email (its content lives in `entity_records.attrs`). */
export const EMAIL_ENTITY = 'Email';

/** The metadata entity that stores a reusable email template (Phase 11 "Email templates"). */
export const EMAIL_TEMPLATE_ENTITY = 'EmailTemplate';

/** Job the worker runs for a queued email. */
export const SEND_EMAIL_JOB = 'system.sendEmail';

/** Record statuses (PLAN §28.3 "Delivery status", per record). 'Inbound' is fetched, not sent. */
export const EMAIL_STATUSES: readonly string[] = ['Draft', 'Queued', 'Sending', 'Sent', 'Failed', 'Inbound'];

/** Statuses a client may queue for sending from; 'Queued'/'Sending' refuse to avoid a double send. */
export const SENDABLE_STATUSES: ReadonlySet<string> = new Set(['Draft', 'Failed']);

/** Per-recipient statuses in `email_deliveries`. */
export const DELIVERY_STATUSES: readonly string[] = ['pending', 'sending', 'sent', 'rejected', 'failed', 'skipped'];

/**
 * The seam for inbound collection (PLAN §28.2): bound to `NullInboundProvider` by default, so an
 * install without an IMAP/Graph adapter polls nothing instead of failing. An extension replaces the
 * token with a real provider without touching this module.
 */
export const INBOUND_MAIL_PROVIDER_TOKEN = Symbol('INBOUND_MAIL_PROVIDER');
