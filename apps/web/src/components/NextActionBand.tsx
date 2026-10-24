import { ArrowRightOutlined } from '@ant-design/icons';
import { App as AntApp, Button } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { EntityDefinition, RowActions } from '../api/types.js';
import { t } from '../state/i18n.js';
import { enumValues } from '../state/metadata.js';

/** The pipeline field names the record types in this product use, most specific first. */
const NEXT_FIELD_CANDIDATES = ['status', 'stage', 'state'];

export interface NextActionBandProps {
  entity: string;
  id: string;
  definition: EntityDefinition | undefined;
  record: Record<string, unknown> | undefined;
  onChanged: () => Promise<void> | void;
}

/**
 * The record's single most useful next step (PLAN_Phase_20_Settings_UX.md §5.4).
 *
 * It is computed, not configured: the first pipeline field the entity declares (`status`, `stage` or
 * `state`) that has more than one value, and the value that follows the record's current one. That is
 * the one step every record type in this product can name without a per-entity catalogue, and it is
 * the same write the edit form would make — the band only saves the operator the trip.
 *
 * It is a hint, not an automation: nothing moves until the button is pressed, no value is ever
 * skipped silently, and a record at the end of its pipeline shows nothing rather than a dead control.
 * The band is absent entirely when the server says the caller may not edit the entity.
 */
export function NextActionBand({ entity, id, definition, record, onChanged }: NextActionBandProps) {
  const { message } = AntApp.useApp();
  const [actions, setActions] = useState<RowActions | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .rowActions(entity)
      .then((next) => {
        if (active) setActions(next);
      })
      .catch(() => {
        if (active) setActions(null);
      });
    return () => {
      active = false;
    };
  }, [entity]);

  const fieldName = NEXT_FIELD_CANDIDATES.find((name) => {
    const field = definition?.fields[name];
    return field !== undefined && field.type === 'enum' && enumValues(field).length > 1;
  });
  const values = fieldName === undefined ? [] : enumValues(definition?.fields[fieldName] ?? { type: 'enum' });
  const current = fieldName === undefined ? '' : String(record?.[fieldName] ?? '');
  const index = values.indexOf(current);
  const next = index >= 0 && index < values.length - 1 ? values[index + 1] : undefined;

  if (actions?.edit !== true || fieldName === undefined || next === undefined) return null;

  const advance = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.update(entity, id, { [fieldName]: next });
      await onChanged();
      void message.success(t('web.detail.nextActionDone', { value: next }));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.detail.nextActionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="carocrm-next-action" role="group" aria-label={t('web.detail.nextAction')}>
      <span className="carocrm-next-action-label">{t('web.detail.nextAction')}</span>
      <span className="carocrm-next-action-text">{t('web.detail.nextActionHint', { value: next })}</span>
      <Button type="primary" size="small" icon={<ArrowRightOutlined />} loading={busy} onClick={() => void advance()}>
        {t('web.detail.nextActionMove', { value: next })}
      </Button>
    </div>
  );
}
