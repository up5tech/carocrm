import { CloseOutlined, FileTextOutlined } from '@ant-design/icons';
import { Tag, Tooltip } from 'antd';

import { t } from '../../state/i18n.js';
import type { CRMChatPageContextState } from './crm-chat-page-context.js';

export type { CRMChatPageContextState } from './crm-chat-page-context.js';

/**
 * Phase 25.9 — the page context chip ("this company", "this opportunity").
 *
 * The chip says what the answer will be about, in the user's own words: the record type and the
 * record's name, both produced by the server (the label is the record's own `name`, never a string
 * the client invented). It is a **reference**, so removing it removes the record from the next
 * turn — it never edits a record.
 *
 * The chip is rendered in two places — the header quick panel and the chat workspace — so the
 * answer reads the same in both.
 */

export interface CRMChatPageContextChipProps {
  readonly context: CRMChatPageContextState;
  /** Omitted when the context cannot be removed. */
  readonly onRemove?: (() => void) | undefined;
}

export function CRMChatPageContextChip({ context, onRemove }: CRMChatPageContextChipProps) {
  const title =
    context.status === 'applied'
      ? t('web.crmChat.pageContext.applied')
      : t('web.crmChat.pageContext.dropped');
  return (
    <Tooltip title={title}>
      <Tag
        className={`carocrm-chat-page-context${context.status === 'dropped' ? ' is-dropped' : ''}`}
        icon={<FileTextOutlined aria-hidden="true" />}
        closable={onRemove !== undefined}
        closeIcon={<CloseOutlined />}
        onClose={(event) => {
          // A tag's close event also bubbles to the tag itself; stopping it keeps the chip from
          // being interpreted as a click on the surrounding row.
          event.stopPropagation();
          onRemove?.();
        }}
        aria-label={t('web.crmChat.pageContext.ariaLabel')}
      >
        {context.label === null ? context.entity : `${context.entity} · ${context.label}`}
      </Tag>
    </Tooltip>
  );
}
