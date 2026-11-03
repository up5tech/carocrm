import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CRM_CHAT_SUGGESTIONS, CRMChatSuggestions, visibleSuggestions } from './CRMChatSuggestions.js';

/**
 * Phase 19-CHAT.24 — a suggestion is a claim the UI can verify
 * (plans/PLAN_Phase_19_CRM_Chat.md §17 `19-CHAT.24`; `plans/SPEC.md` §9.7).
 *
 * Rendered to static markup, like the other SPA suites, so this runs in the node test project with no
 * DOM and no i18n catalog — `t()` answers with the key, which is exactly what makes *which chip was
 * offered* observable. The wording itself is the catalog test's business, asserted at the bottom.
 */

/** The eight tools the shipped chip table depends on. */
const ALL_TOOLS = CRM_CHAT_SUGGESTIONS.map((suggestion) => suggestion.requiresTool);

describe('tool-aware suggestions (19-CHAT.24)', () => {
  it('does not offer a question whose tool the answering agent does not hold', () => {
    const granted = ALL_TOOLS.filter((tool) => tool !== 'crm_lead_score' && tool !== 'crm_stale_records');
    const html = renderToStaticMarkup(<CRMChatSuggestions tools={granted} onSelect={() => undefined} />);

    expect(html).not.toContain('web.crmChat.suggestion.hotLeadScore');
    expect(html).not.toContain('web.crmChat.suggestion.staleAccounts');
    // The rest of the row is still there: a missing capability hides one chip, not the empty state.
    expect(html).toContain('web.crmChat.suggestion.opportunities');
    expect(html).toContain('web.crmChat.suggestion.followUpEmail');
  });

  it('offers every question to an agent that holds every tool behind them', () => {
    const html = renderToStaticMarkup(<CRMChatSuggestions tools={ALL_TOOLS} onSelect={() => undefined} />);
    for (const suggestion of CRM_CHAT_SUGGESTIONS) {
      expect(html, suggestion.key).toContain(`web.crmChat.suggestion.${suggestion.key}`);
    }
    expect(html.match(/carocrm-chat-suggestion"/g)).toHaveLength(CRM_CHAT_SUGGESTIONS.length);
  });

  it('renders no row at all when the agent holds none of the tools', () => {
    // An unrelated grant must not unlock a chip: the filter is per tool, not "any tool at all".
    expect(renderToStaticMarkup(<CRMChatSuggestions tools={['docs_search']} onSelect={() => undefined} />)).toBe('');
    expect(visibleSuggestions([])).toHaveLength(0);
  });

  it('keeps the chip order the deployment advertises, and never duplicates one', () => {
    expect(visibleSuggestions(ALL_TOOLS).map((suggestion) => suggestion.key)).toEqual(
      CRM_CHAT_SUGGESTIONS.map((suggestion) => suggestion.key),
    );
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it('names a tool the registry actually has, and a phrase both catalogs carry', () => {
    // The registry keys are asserted in `crm-chat-evaluation.test.ts`; here the chip table must at least
    // agree with itself: one tool per chip, declared once.
    for (const suggestion of CRM_CHAT_SUGGESTIONS) {
      expect(suggestion.requiresTool).toMatch(/^crm_|^docs_/);
    }

    for (const locale of ['en', 'vi']) {
      const catalog = JSON.parse(readFileSync(join(process.cwd(), 'i18n', locale, 'web.json'), 'utf8')) as {
        crmChat: { suggestion: Record<string, string> };
      };
      for (const suggestion of CRM_CHAT_SUGGESTIONS) {
        const phrase = catalog.crmChat.suggestion[suggestion.key] ?? '';
        expect(phrase, `missing key ${locale}: web.crmChat.suggestion.${suggestion.key}`).not.toBe('');
        expect(phrase.length, `${locale}: ${suggestion.key} is empty`).toBeGreaterThan(8);
      }
    }
  });
});
