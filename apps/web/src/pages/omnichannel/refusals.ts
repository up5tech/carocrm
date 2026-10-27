import { t } from '../../state/i18n.js';

/**
 * 19-OM.14 — a refusal is a *code*; the person reading it needs the sentence that says what to do
 * next (window closed vs opted out vs unsupported lead to different steps). The server sends the
 * codes; the catalogue turns them into sentences.
 */
export function refusalSentence(code: string): string {
  const translated = t(`omnichannel.refusal.${code}`);
  return translated.startsWith('omnichannel.refusal.') ? code : translated;
}

/**
 * The message plus its reasons, in one line: the server's message and every refusal code it
 * carries, each translated. Used by the workspace (an agent) and by the widget (a visitor), so the
 * visitor never reads a raw English sentence in a Vietnamese widget.
 */
export function errorText(error: unknown, fallbackKey: string): string {
  const body = (error as { body?: { error?: { message?: string; details?: { refusals?: string[] } } } }).body;
  const message = body?.error?.message ?? (error instanceof Error ? error.message : t(fallbackKey));
  const refusals = body?.error?.details?.refusals;
  if (refusals === undefined || refusals.length === 0) return message;
  return `${message} — ${refusals.map(refusalSentence).join(' ')}`;
}
