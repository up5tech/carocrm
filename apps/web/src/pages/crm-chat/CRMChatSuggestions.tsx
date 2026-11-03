import { ThunderboltOutlined } from '@ant-design/icons';

import { t } from '../../state/i18n.js';

/**
 * Phase 19-CHAT.24 — the empty-state suggestions as declared data
 * (plans/PLAN_Phase_19_CRM_Chat.md §17 `19-CHAT.24`; `plans/SPEC.md` §9.7).
 *
 * A suggestion is a promise the assistant makes on the deployment's behalf, so each one names the
 * registry key that has to be present for the promise to be keepable. The page filters this list by
 * `capabilities.assistant.tools` — the tools of the agent that will actually answer — so a question
 * the answering agent cannot reach is never offered.
 *
 * The order is the order they render in.
 */
export interface CRMChatSuggestion {
  /** The translation key suffix under `web.crmChat.suggestion`. */
  readonly key: string;
  /** The tool whose presence in the answering agent's grants makes this question answerable. */
  readonly requiresTool: string;
}

export const CRM_CHAT_SUGGESTIONS: readonly CRMChatSuggestion[] = [
  { key: 'opportunities', requiresTool: 'crm_search_records' },
  { key: 'closingQuarter', requiresTool: 'crm_aggregate' },
  { key: 'myToday', requiresTool: 'crm_list_activities' },
  { key: 'staleAccounts', requiresTool: 'crm_stale_records' },
  { key: 'accountThreeSixty', requiresTool: 'crm_cross_module' },
  { key: 'hotLeadScore', requiresTool: 'crm_lead_score' },
  { key: 'followUpEmail', requiresTool: 'crm_draft_email' },
  { key: 'callOutcome', requiresTool: 'crm_post_note' },
];

/** The suggestions this set of tool grants can honour, in declaration order. */
export function visibleSuggestions(tools: readonly string[]): readonly CRMChatSuggestion[] {
  return CRM_CHAT_SUGGESTIONS.filter((suggestion) => tools.includes(suggestion.requiresTool));
}

export interface CRMChatSuggestionsProps {
  /** The answering agent's tool keys, as the capabilities payload reports them. */
  readonly tools: readonly string[];
  readonly onSelect: (text: string) => void;
}

/**
 * Renders nothing when the answering agent holds none of the tools these questions need: an empty
 * row of cards would be a paragraph of markup with nothing to say.
 */
export function CRMChatSuggestions({ tools, onSelect }: CRMChatSuggestionsProps) {
  const visible = visibleSuggestions(tools);
  if (visible.length === 0) return null;

  return (
    <div className="carocrm-chat-suggestions" aria-label={t('web.crmChat.suggestionsTitle')}>
      {visible.map((suggestion) => {
        const label = t(`web.crmChat.suggestion.${suggestion.key}`);
        return (
          <button
            key={suggestion.key}
            type="button"
            className="carocrm-chat-suggestion"
            onClick={() => onSelect(label)}
          >
            <ThunderboltOutlined aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
