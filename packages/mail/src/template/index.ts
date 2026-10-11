/**
 * Email template rendering (PLAN Phase 11 "Email templates").
 *
 * Deliberately tiny: `{{placeholder}}` substitution over a plain variable map. Templates live as
 * EmailTemplate entity records (subject/body/bodyHtml); the API renders them when a send is queued
 * and stores the rendered text on the Email record, so the worker and the audit trail both see the
 * exact content that went out. Unknown placeholders are removed rather than leaked to recipients.
 */
export type TemplateVariables = Record<string, string | number | boolean | null | undefined>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Renders `{{name}}` placeholders; an unknown or empty variable becomes an empty string. */
export function renderTemplate(template: string, variables: TemplateVariables): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

/** Renders every text part of a template record; missing parts stay missing. */
export function renderTemplateParts(
  template: { subject?: string | null | undefined; body?: string | null | undefined; bodyHtml?: string | null | undefined },
  variables: TemplateVariables,
): { subject: string | null; body: string | null; bodyHtml: string | null } {
  return {
    subject: template.subject == null ? null : renderTemplate(template.subject, variables),
    body: template.body == null ? null : renderTemplate(template.body, variables),
    bodyHtml: template.bodyHtml == null ? null : renderTemplate(template.bodyHtml, variables),
  };
}