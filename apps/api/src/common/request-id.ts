/**
 * The correlation id a request carries: a bounded, printable `x-correlation-id` from a proxy or
 * caller, otherwise Fastify's own request id. The same value is echoed in `x-request-id`.
 *
 * The pattern is deliberately conservative: it is a log/header token, not user data, and a caller
 * cannot make a log line ambiguous or enormous by sending an arbitrary value.
 */
export function resolveRequestId(supplied: string | string[] | undefined, fallback: string): string {
  return typeof supplied === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(supplied) ? supplied : fallback;
}
