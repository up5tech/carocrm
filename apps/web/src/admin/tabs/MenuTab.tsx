import { ArrowDownOutlined, ArrowUpOutlined, EditOutlined, HolderOutlined, RollbackOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Form, Input, Modal, Select, Skeleton, Space, Switch, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { NavigationDocument, NavigationMenuEntry, NavigationNode, NavigationTree } from '../../api/types.js';
import { NAV_ICON_NAMES, navIcon } from '../../components/entityIcons.js';
import { HelpTip } from '../../components/HelpTip.js';
import { useNavigation } from '../../state/admin.js';
import { t } from '../../state/i18n.js';
import { useMetadata } from '../../state/metadata.js';
import { useResolvedTheme } from '../../state/theme.js';
import { NAV_ACCENT_NAMES, navAccent } from '../../theme.js';
import { useDocumentForm } from '../document-form.js';
import { usePublishTabActions } from '../shell.js';

/**
 * Main Menu tab (PLAN_Phase_20_Settings_UX.md §4.4) — the headline settings capability of the phase.
 *
 * The rows are the entries this instance can actually show, taken from the server-resolved tree and
 * merged with the overrides the `navigation` document holds. An editor row can be renamed, moved,
 * recoloured or switched off; the order and enablement the administrator leaves untouched produce no
 * override at all, so the entry keeps following the platform default (including a new entity added
 * after this document was written).
 *
 * The document is presentation only. Every entry the caller cannot open is absent from the tree this
 * editor is built from, and switching an entry on here can never make a forbidden record appear.
 */
interface MenuRow {
  key: string;
  parentKey: string;
  depth: number;
  kind: string;
  label: string;
  route: string;
  enabled: boolean;
  order: number;
  labelKey?: string | undefined;
  icon?: string | undefined;
  accent?: string | undefined;
}

interface MenuEditorDraft {
  key: string;
  label: string;
  labelKey: string;
  icon?: string | undefined;
  accent?: string | undefined;
}

const EMPTY_DOCUMENT: NavigationDocument = { items: [], groups: [], accentPalette: [] };

export function MenuTab() {
  const document = useDocumentForm<NavigationDocument>('navigation');
  // An accent is a label colour, so the preview follows the mode it is painted in.
  const dark = useResolvedTheme() === 'dark';
  const tree = useNavigation();
  const metadata = useMetadata();
  const { modal, message } = AntApp.useApp();
  const [rows, setRows] = useState<MenuRow[] | undefined>(undefined);
  const [dragKey, setDragKey] = useState<string | null>(null);
  // §4.9 preview as another principal: resolve the menu the target would see.
  const [previewUserId, setPreviewUserId] = useState<string>('');
  const [previewUsers, setPreviewUsers] = useState<{ id: string; userName: string }[]>([]);
  const [previewTree, setPreviewTree] = useState<NavigationTree | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // The row keeps only its identity and actions; the presentation fields live in a modal so a long
  // menu is not a wall of selects. Editing is a draft until Save, so Cancel leaves the row alone.
  const [editor, setEditor] = useState<MenuEditorDraft | null>(null);

  const baseline = useMemo(() => {
    if (tree.data === undefined) return undefined;
    const overrides = overrideIndex(document.value ?? EMPTY_DOCUMENT);
    const listed = flatten(tree.data.items, overrides);
    // An entry the document switched off is not in the resolved tree, but the editor has to show it
    // so the administrator can switch it back on.
    const known = new Set(listed.map((row) => row.key));
    const restored: MenuRow[] = [];
    for (const entry of [...(document.value?.items ?? []), ...(document.value?.groups ?? [])]) {
      if (entry.enabled !== false || known.has(entry.key)) continue;
      // A switched-off entry is not in the resolved tree, so it is listed at the end of the top level
      // under the name its key carries; moving it back up the list is what re-orders it.
      restored.push({ key: entry.key, parentKey: '', depth: 0, kind: kindOf(entry.key), label: labelFor(entry.key, metadata.data), route: '', enabled: false, order: entry.order, labelKey: entry.labelKey, icon: entry.icon, accent: entry.accent });
    }
    return [...listed, ...restored];
  }, [tree.data, document.value, metadata.data]);

  // Load the user list once so the preview selector can offer principals.
  useEffect(() => {
    let cancelled = false;
    void api.users({ maxSize: 200 }).then((result) => {
      if (cancelled) return;
      setPreviewUsers((result.list ?? []).map((row) => ({ id: String(row.id), userName: String(row.userName) })));
    }).catch(() => { /* preview is optional; ignore */ });
    return () => { cancelled = true; };
  }, []);

  // Resolve the target's menu whenever the selector changes.
  useEffect(() => {
    if (previewUserId === '') {
      setPreviewTree(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    void api.navigation(previewUserId).then((tree) => {
      if (cancelled) return;
      setPreviewTree(tree);
    }).catch(() => {
      if (cancelled) return;
      setPreviewTree(null);
    }).finally(() => {
      if (!cancelled) setPreviewLoading(false);
    });
    return () => { cancelled = true; };
  }, [previewUserId]);

  const baselineReady = baseline !== undefined && document.value !== undefined;
  useEffect(() => {
    // Seed the editor copy once both the tree and the document have arrived.
    if (baselineReady) setRows((current) => current ?? baseline);
  }, [baselineReady, baseline]);

  // The editor works on a copy; Discard throws it away, a save turns the differences into overrides.
  const current = rows ?? baseline;

  // The document draft is not the editor: dirtiness is whether the rows the administrator sees differ
  // from the rows that were loaded, because only the differences become overrides on save.
  const edited = current !== undefined && baseline !== undefined && JSON.stringify(toDocument(baseline, current)) !== JSON.stringify(toDocument(baseline, baseline));

  usePublishTabActions({
    dirty: edited || document.dirty,
    saving: document.saving,
    canSave: current !== undefined,
    modifiedAt: document.modifiedAt,
    modifiedBy: document.modifiedBy,
    onSave: () => {
      if (baseline === undefined || current === undefined) return;
      void document.save(toDocument(baseline, current));
    },
    onDiscard: () => {
      setRows(baseline);
      document.discard();
    },
    onReload: () => {
      setRows(undefined);
      void document.reload();
      void tree.refetch();
    },
  });

  if (current === undefined || baseline === undefined) return <Skeleton active paragraph={{ rows: 10 }} />;

  const patch = (key: string, next: Partial<MenuRow>): void => {
    setRows(current.map((row) => (row.key === key ? { ...row, ...next } : row)));
  };

  const openEditor = (row: MenuRow): void => {
    setEditor({ key: row.key, label: row.label, labelKey: row.labelKey ?? '', icon: row.icon, accent: row.accent });
  };

  const applyEditor = (): void => {
    if (editor === null) return;
    const labelKey = editor.labelKey.trim();
    patch(editor.key, {
      labelKey: labelKey === '' ? undefined : labelKey,
      icon: editor.icon,
      accent: editor.accent,
    });
    setEditor(null);
  };

  const move = (key: string, delta: -1 | 1): void => {
    const row = current.find((candidate) => candidate.key === key);
    if (row === undefined) return;
    const siblings = current.filter((candidate) => candidate.parentKey === row.parentKey);
    const index = siblings.findIndex((candidate) => candidate.key === key);
    const target = siblings[index + delta];
    if (target === undefined) {
      void message.info(t('web.adminMenu.edgeOfList'));
      return;
    }
    const reordered = [...current];
    const from = reordered.findIndex((candidate) => candidate.key === key);
    const to = reordered.findIndex((candidate) => candidate.key === target.key);
    const [moved] = reordered.splice(from, 1);
    if (moved === undefined) return;
    reordered.splice(to, 0, moved);
    setRows(reordered);
    announce(`${moved.label} ${delta === -1 ? t('web.adminShell.movedUp') : t('web.adminShell.movedDown')}`);
  };

  const drop = (targetKey: string): void => {
    if (dragKey === null || dragKey === targetKey) return;
    const dragged = current.find((row) => row.key === dragKey);
    const target = current.find((row) => row.key === targetKey);
    setDragKey(null);
    if (dragged === undefined || target === undefined || dragged.parentKey !== target.parentKey) return;
    const reordered = current.filter((row) => row.key !== dragged.key);
    const at = reordered.findIndex((row) => row.key === target.key);
    reordered.splice(at, 0, dragged);
    setRows(reordered);
  };

  const restoreDefaults = (): void => {
    modal.confirm({
      title: t('web.adminMenu.restoreTitle'),
      content: t('web.adminMenu.restoreBody'),
      okText: t('web.adminMenu.restoreAction'),
      cancelText: t('core.common.cancel'),
      onOk: async () => {
        await document.restoreDefaults();
        setRows(undefined);
        void tree.refetch();
      },
    });
  };

  return (
    <div className="carocrm-admin-form carocrm-admin-form--two">
      {document.failed !== null ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={document.failed}
          description={document.conflict ? t('web.adminShell.conflictHint') : undefined}
        />
      ) : null}
      {document.warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('web.adminSettings.warnings')}
          description={<ul className="carocrm-admin-warnings">{document.warnings.map((warning) => <li key={`${warning.code}:${warning.message}`}>{warning.message}</li>)}</ul>}
        />
      ) : null}

      <Card
        className="carocrm-card"
        title={t('web.adminMenu.title')}
        extra={
          <Space size={4}>
            <Button size="small" icon={<RollbackOutlined />} onClick={restoreDefaults}>
              {t('web.adminMenu.restoreAction')}
            </Button>
            {/* The one control on this tab that clears every administrator's work at once is exactly
                where a "Learn more" belongs (§5.6). */}
            <HelpTip docKey="admin/main-menu">{t('web.adminMenu.restoreHint')}</HelpTip>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t('web.adminMenu.hint')}
        </Typography.Paragraph>
        <ul className="carocrm-menu-rows" role="list">
          {current.map((row) => (
            <li
              key={row.key}
              className={`carocrm-menu-row carocrm-menu-row--${row.kind}${row.enabled ? '' : ' is-off'}${dragKey === row.key ? ' is-dragging' : ''}`}
              style={{ paddingLeft: 8 + row.depth * 18, borderLeftColor: navAccent(row.accent, dark).fg }}
              draggable
              onDragStart={() => setDragKey(row.key)}
              onDragEnd={() => setDragKey(null)}
              onDragOver={(event) => {
                if (dragKey !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                drop(row.key);
              }}
            >
              <span className="carocrm-menu-row-grip" aria-hidden="true" title={t('web.adminMenu.dragHint')}>
                <HolderOutlined />
              </span>
              <div className="carocrm-menu-row-top">
                <span className="carocrm-menu-row-icon" aria-hidden="true">
                  {row.icon !== undefined ? navIcon(row.icon) : null}
                </span>
                <span className="carocrm-menu-row-label" title={row.route || row.key}>
                  {row.label}
                  <Typography.Text type="secondary" className="carocrm-menu-row-key">
                    {row.key}
                  </Typography.Text>
                </span>
                <div className="carocrm-menu-row-actions">
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => openEditor(row)}
                    aria-label={t('web.adminMenu.editEntry', { name: row.label })}
                  />
                  <Switch size="small" checked={row.enabled} aria-label={t('web.adminMenu.enableEntry')} onChange={(checked) => patch(row.key, { enabled: checked })} />
                  <Button size="small" icon={<ArrowUpOutlined />} onClick={() => move(row.key, -1)} aria-label={t('web.adminShell.movedUp')} />
                  <Button size="small" icon={<ArrowDownOutlined />} onClick={() => move(row.key, 1)} aria-label={t('web.adminShell.movedDown')} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="carocrm-card carocrm-menu-preview-card" title={t('web.adminMenu.previewTitle')}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t('web.adminMenu.previewHint')}
        </Typography.Paragraph>
        <nav className="carocrm-menu-preview" aria-label={t('web.adminMenu.previewTitle')}>
          <MenuPreview rows={current} />
        </nav>
      </Card>

      <Card className="carocrm-card" title={t('web.adminMenu.previewAsTitle')}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t('web.adminMenu.previewAsHint')}
        </Typography.Paragraph>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={t('web.adminMenu.previewAsPlaceholder')}
          value={previewUserId === '' ? undefined : previewUserId}
          onChange={(value) => setPreviewUserId(value ?? '')}
          options={previewUsers.map((user) => ({ value: user.id, label: user.userName }))}
          style={{ width: '100%', marginBottom: 12 }}
        />
        {previewLoading ? <Typography.Text type="secondary">{t('core.loading')}</Typography.Text> : null}
        {previewTree !== null ? (
          <nav className="carocrm-menu-preview" aria-label={t('web.adminMenu.previewAsTitle')}>
            <MenuPreviewTree nodes={previewTree.items} />
          </nav>
        ) : null}
      </Card>

      <Modal
        open={editor !== null}
        title={editor === null ? undefined : t('web.adminMenu.editTitle', { name: editor.label })}
        okText={t('web.common.save')}
        cancelText={t('core.common.cancel')}
        onOk={applyEditor}
        onCancel={() => setEditor(null)}
        destroyOnHidden
      >
        {editor === null ? null : (
          <Form layout="vertical">
            <Form.Item label={t('web.adminMenu.label')}>
              <Input
                autoFocus
                placeholder={t('web.adminMenu.labelKeyPlaceholder')}
                value={editor.labelKey}
                onChange={(event) => setEditor({ ...editor, labelKey: event.target.value })}
              />
            </Form.Item>
            <Form.Item label={t('web.adminMenu.icon')}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder={t('web.adminMenu.icon')}
                value={editor.icon}
                options={NAV_ICON_NAMES.map((name) => ({ value: name, label: <span className="carocrm-menu-select-option"><span className="carocrm-menu-select-icon">{navIcon(name)}</span>{name}</span> }))}
                onChange={(value?: string) => setEditor({ ...editor, icon: value })}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item label={t('web.adminMenu.accent')}>
              <Select
                allowClear
                placeholder={t('web.adminMenu.accent')}
                value={editor.accent}
                options={NAV_ACCENT_NAMES.map((name) => ({ value: name, label: <span className="carocrm-menu-select-option"><span className="carocrm-menu-select-swatch" style={{ background: navAccent(name, dark).fg }} />{name}</span> }))}
                onChange={(value?: string) => setEditor({ ...editor, accent: value })}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  );
}

function MenuPreviewTree({ nodes }: { nodes: readonly NavigationNode[] }) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.key} className="carocrm-menu-preview-row" style={{ paddingLeft: 6 }}>
          {node.label}
          {node.children !== undefined && node.children.length > 0 ? (
            <div style={{ paddingLeft: 12 }}>
              <MenuPreviewTree nodes={node.children} />
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

function MenuPreview({ rows }: { rows: readonly MenuRow[] }) {
  const dark = useResolvedTheme() === 'dark';
  return (
    <>
      {rows
        .filter((row) => row.enabled)
        .map((row) => (
          <span
            key={row.key}
            className={`carocrm-menu-preview-row carocrm-menu-preview-row--${row.kind}`}
            style={{ paddingLeft: 6 + row.depth * 14, color: row.depth === 0 ? undefined : navAccent(row.accent, dark).fg }}
          >
            {row.label}
          </span>
        ))}
    </>
  );
}

/** Screen-reader announcement for a keyboard move (§5.8: a drag has to announce itself). */
function announce(message: string): void {
  const live = document.getElementById('carocrm-live-region');
  if (live) live.textContent = message;
}

function overrideIndex(document: NavigationDocument): Map<string, NavigationMenuEntry> {
  const out = new Map<string, NavigationMenuEntry>();
  for (const item of document.items ?? []) out.set(item.key, item);
  for (const group of document.groups ?? []) out.set(group.key.startsWith('group:') ? group.key : `group:${group.key}`, group);
  return out;
}

function flatten(nodes: readonly NavigationNode[], overrides: Map<string, NavigationMenuEntry>, depth = 0, parentKey = ''): MenuRow[] {
  return nodes.map((node, index) => {
    const override = overrides.get(node.key);
    const row: MenuRow = {
      key: node.key,
      parentKey,
      depth,
      kind: node.kind,
      label: node.label,
      route: node.route,
      enabled: override?.enabled !== false,
      order: index * 10,
      labelKey: override?.labelKey,
      icon: override?.icon,
      accent: override?.accent,
    };
    const children = node.children === undefined ? [] : flatten(node.children, overrides, depth + 1, node.key);
    return [row, ...children];
  }).flat();
}

function kindOf(key: string): string {
  if (key.startsWith('group:')) return 'group';
  if (key.startsWith('entity:')) return 'entity';
  if (key.startsWith('admin:')) return 'admin';
  if (key.startsWith('extension:')) return 'extension';
  return 'page';
}

function labelFor(key: string, metadata: Record<string, unknown> | undefined): string {
  if (key.startsWith('entity:')) {
    const name = key.slice('entity:'.length);
    const definition = metadata?.[name] as { label?: string } | undefined;
    if (definition?.label !== undefined) return definition.label;
  }
  return key;
}

/**
 * Only the differences against what the tab loaded become overrides: an entry the administrator did
 * not touch keeps following the shipped default, so a later upgrade still moves it.
 */
function toDocument(baseline: readonly MenuRow[], current: readonly MenuRow[]): NavigationDocument {
  const before = new Map(baseline.map((row) => [row.key, row]));
  const movedParents = new Set<string>();
  for (const parent of new Set(current.map((row) => row.parentKey))) {
    const was = baseline.filter((row) => row.parentKey === parent).map((row) => row.key);
    const is = current.filter((row) => row.parentKey === parent).map((row) => row.key);
    if (was.join('|') !== is.join('|')) movedParents.add(parent);
  }

  const items: NavigationMenuEntry[] = [];
  const groups: NavigationMenuEntry[] = [];
  current.forEach((row, index) => {
    const order = current.filter((candidate) => candidate.parentKey === row.parentKey).findIndex((candidate) => candidate.key === row.key) * 10;
    const original = before.get(row.key);
    const changedOrder = movedParents.has(row.parentKey);
    const edited = row.labelKey !== undefined || row.icon !== undefined || row.accent !== undefined;
    const switched = original !== undefined ? original.enabled !== row.enabled : row.enabled === false;
    void index;
    if (!changedOrder && !edited && !switched) return;
    const entry: NavigationMenuEntry = {
      key: row.key,
      enabled: row.enabled,
      order: changedOrder ? order : (original?.order ?? row.order),
      ...(row.labelKey === undefined ? {} : { labelKey: row.labelKey }),
      ...(row.icon === undefined ? {} : { icon: row.icon }),
      ...(row.accent === undefined ? {} : { accent: row.accent }),
    };
    if (row.kind === 'group') groups.push(entry);
    else items.push(entry);
  });
  return { items, groups, accentPalette: [...NAV_ACCENT_NAMES] };
}
