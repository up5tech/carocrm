import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Button, Checkbox, Modal, Space, Typography } from 'antd';

import { t } from '../state/i18n.js';
import { type FieldEntry,fieldLabel } from '../state/metadata.js';

export interface ColumnManagerProps {
  open: boolean;
  /** Every column the entity's list layout offers, in metadata order. */
  columns: FieldEntry[];
  /** The visible columns, in the order the user arranged them. */
  visible: string[];
  onClose: () => void;
  /** The new ordered visible set, or `null` to fall back to the shipped layout. */
  onChange: (next: string[] | null) => void;
}

/**
 * Column manager (PLAN_Phase_20_Settings_UX.md §5.3): show/hide and reorder the list columns, saved
 * per user per entity in the `columns` preference.
 *
 * Reordering is buttons, not drag: `Shift+Tab`/`Enter` on "Move up" is the keyboard path, so no
 * interaction here is pointer-only (§5.8). The frozen identifier column cannot be hidden or moved —
 * a row without its name is not a row — so it stays first and its checkbox is disabled.
 */
export function ColumnManager({ open, columns, visible, onClose, onChange }: ColumnManagerProps) {
  const byName = new Map(columns.map((entry) => [entry.name, entry]));
  const orderedVisible = visible.filter((name) => byName.has(name));
  const hidden = columns.map((entry) => entry.name).filter((name) => !orderedVisible.includes(name));
  const all = [...orderedVisible, ...hidden];
  const firstVisible = orderedVisible[0];

  const toggle = (name: string, checked: boolean): void => {
    const next = checked
      ? [...orderedVisible, name]
      : orderedVisible.filter((candidate) => candidate !== name);
    onChange(next);
  };

  const move = (name: string, delta: -1 | 1): void => {
    const index = orderedVisible.indexOf(name);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= orderedVisible.length) return;
    const next = [...orderedVisible];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    onChange(next);
  };

  return (
    <Modal
      open={open}
      title={t('web.list.columnsTitle')}
      onCancel={onClose}
      onOk={onClose}
      okText={t('core.common.close')}
      cancelButtonProps={{ style: { display: 'none' } }}
      width={520}
    >
      <Typography.Paragraph type="secondary">{t('web.list.columnsHint')}</Typography.Paragraph>
      <div className="carocrm-column-manager">
        {all.map((name) => {
          const entry = byName.get(name);
          if (entry === undefined) return null;
          const index = orderedVisible.indexOf(name);
          const checked = index >= 0;
          const pinned = checked && name === firstVisible;
          return (
            <div key={name} className="carocrm-column-row">
              <Checkbox
                checked={checked}
                disabled={pinned}
                onChange={(event) => toggle(name, event.target.checked)}
              >
                {fieldLabel(name, entry.field)}
              </Checkbox>
              <Space size={2}>
                <Button
                  size="small"
                  type="text"
                  icon={<ArrowUpOutlined />}
                  aria-label={t('web.list.columnMoveUp', { column: fieldLabel(name, entry.field) })}
                  disabled={!checked || index <= 0}
                  onClick={() => move(name, -1)}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<ArrowDownOutlined />}
                  aria-label={t('web.list.columnMoveDown', { column: fieldLabel(name, entry.field) })}
                  disabled={!checked || index === orderedVisible.length - 1}
                  onClick={() => move(name, 1)}
                />
              </Space>
            </div>
          );
        })}
      </div>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        {t('web.list.columnsResetHint')}
      </Typography.Paragraph>
      <Button size="small" onClick={() => onChange(null)}>
        {t('web.list.columnsReset')}
      </Button>
    </Modal>
  );
}
