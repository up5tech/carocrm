/**
 * Phase 19-SD.6 — the Case conversation panel (PLAN §5.4, task SD.6.5).
 *
 * The panel exists to make posting *mode* impossible to misread: posting mode is an explicit
 * segmented control, the composer text and button change with it, an internal note is visually
 * distinct (amber, locked), and sending a customer-visible reply asks for confirmation. Nothing here
 * decides visibility — the `reply` and `note` commands fix it server-side, and each timeline entry
 * carries the visibility the server assigned, which is what the badge renders.
 *
 * Attachments are uploaded against the Case and then linked to the message by the command, so the
 * server can lower their visibility when the message is internal (the file then disappears from the
 * portal, even though the case is readable).
 */

import {
  LockOutlined,
  PaperClipOutlined,
  SendOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { App as AntApp, Avatar, Button, Card, Input, Popconfirm, Segmented, Space, Spin, Tag, Tooltip, Typography, Upload } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type StreamItem } from '../api/client.js';
import type { EntityDefinition } from '../api/types.js';
import { t } from '../state/i18n.js';
import { EmptyState } from './EmptyState.js';
import { updateSummary } from './StreamPanel.js';

const { TextArea } = Input;

type Mode = 'public' | 'internal';

interface PendingAttachment {
  readonly id: string;
  readonly name: string;
}

interface CaseConversationProps {
  readonly caseId: string;
  readonly definition?: EntityDefinition | undefined;
  readonly onChanged?: (() => void | Promise<void>) | undefined;
}

function authorName(item: StreamItem): string {
  const name = item.createdBy;
  if (!name) return t('web.stream.unknownUser');
  const full = `${name.firstName ?? ''} ${name.lastName ?? ''}`.trim();
  return full !== '' ? full : name.userName;
}

function initialsOf(item: StreamItem): string {
  const name = item.createdBy;
  return (name?.firstName ?? name?.userName ?? '∆').slice(0, 2).toUpperCase();
}

function mentionText(value: string): string {
  return value.replace(/@\[([^\]]+)\]/g, '@$1');
}

function isInternal(item: StreamItem): boolean {
  return item.visibility !== 'public';
}

export function CaseConversation({ caseId, definition, onChanged }: CaseConversationProps) {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<StreamItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [canReply, setCanReply] = useState(false);
  const [mode, setMode] = useState<Mode>('public');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [timeline, capabilities] = await Promise.all([
        api.serviceDeskConversation(caseId, { maxSize: 100 }),
        api.serviceDeskCapabilities(caseId),
      ]);
      setItems(timeline.list);
      setCanReply(capabilities.conversation?.canReply === true);
      setDenied(false);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 403 || status === 404) {
        setDenied(true);
      } else {
        void message.error(error instanceof Error ? error.message : t('web.serviceDesk.conversation.loadFailed'));
      }
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [caseId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // Resolve attachment file names once per id; a failure falls back to the id so the link still works.
  const attachmentIds = useMemo(
    () => [...new Set(items.flatMap((item) => item.attachmentIds))],
    [items],
  );
  useEffect(() => {
    const missing = attachmentIds.filter((id) => names[id] === undefined);
    if (missing.length === 0) return;
    let active = true;
    void Promise.all(
      missing.map(async (id): Promise<readonly [string, string]> => {
        try {
          const info = await api.attachment(id);
          return [id, info.name] as const;
        } catch {
          return [id, id] as const;
        }
      }),
    ).then((entries) => {
      if (active) setNames((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => {
      active = false;
    };
  }, [attachmentIds, names]);

  const uploadFile = async (file: File): Promise<void> => {
    setUploading(true);
    try {
      const info = await api.uploadAttachment(file, { parentType: 'Case', parentId: caseId, field: 'attachment' });
      setPending((prev) => [...prev, { id: info.id, name: info.name }]);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.serviceDesk.conversation.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' && pending.length === 0) return;
    setPosting(true);
    const sending = mode;
    try {
      const input = { text, ...(pending.length > 0 ? { attachmentIds: pending.map((entry) => entry.id) } : {}) };
      if (sending === 'public') await api.serviceDeskReply(caseId, input);
      else await api.serviceDeskNote(caseId, input);
      setDraft('');
      setPending([]);
      void message.success(
        t(sending === 'public' ? 'web.serviceDesk.conversation.replySent' : 'web.serviceDesk.conversation.noteAdded'),
      );
      await load();
      if (onChanged) await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.serviceDesk.conversation.postFailed'));
    } finally {
      setPosting(false);
    }
  };

  const count = items.length;
  const composerDisabled = !canReply;

  return (
    <Card
      className="carocrm-card"
      title={
        <Space size={8}>
          <Typography.Text strong>{t('web.serviceDesk.conversation.title')}</Typography.Text>
          {count > 0 ? <Tag>{count}</Tag> : null}
        </Space>
      }
    >
      {loading && items.length === 0 ? (
        <Spin />
      ) : denied ? (
        <EmptyState size="compact" description={t('web.serviceDesk.conversation.denied')} />
      ) : items.length === 0 ? (
        <EmptyState size="compact" description={t('web.serviceDesk.conversation.empty')} />
      ) : (
        <div className="carocrm-stream-list">
          {items.map((item) => (
            <ConversationEntry
              key={item.id}
              item={item}
              definition={definition}
              names={names}
            />
          ))}
        </div>
      )}

      {canReply ? (
        <div className={`carocrm-conversation-composer carocrm-conversation-${mode}`}>
          <Segmented<Mode>
            block
            value={mode}
            onChange={setMode}
            options={[
              { value: 'public', label: t('web.serviceDesk.conversation.modePublic'), icon: <UserOutlined /> },
              { value: 'internal', label: t('web.serviceDesk.conversation.modeInternal'), icon: <LockOutlined /> },
            ]}
          />
          <TextArea
            rows={3}
            style={{ marginTop: 8 }}
            value={draft}
            placeholder={t(
              mode === 'public'
                ? 'web.serviceDesk.conversation.publicPlaceholder'
                : 'web.serviceDesk.conversation.internalPlaceholder',
            )}
            onChange={(event) => setDraft(event.target.value)}
            onPressEnter={(event) => {
              if (event.metaKey || event.ctrlKey) void submit();
            }}
          />

          {pending.length > 0 ? (
            <Space size={6} wrap style={{ marginTop: 8 }}>
              {pending.map((entry) => (
                <Tag
                  key={entry.id}
                  closable
                  icon={<PaperClipOutlined />}
                  onClose={(event) => {
                    event.preventDefault();
                    setPending((prev) => prev.filter((candidate) => candidate.id !== entry.id));
                  }}
                >
                  {entry.name}
                </Tag>
              ))}
            </Space>
          ) : null}

          <Space style={{ marginTop: 10 }} wrap>
            {mode === 'public' ? (
              <Popconfirm
                title={t('web.serviceDesk.conversation.confirmPublicTitle')}
                description={t('web.serviceDesk.conversation.confirmPublicDesc')}
                okText={t('web.serviceDesk.conversation.confirmPublicOk')}
                cancelText={t('web.serviceDesk.conversation.confirmCancel')}
                disabled={draft.trim() === '' && pending.length === 0}
                onConfirm={() => void submit()}
              >
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  loading={posting}
                  disabled={draft.trim() === '' && pending.length === 0}
                >
                  {t('web.serviceDesk.conversation.sendReply')}
                </Button>
              </Popconfirm>
            ) : (
              <Button
                type="primary"
                danger
                icon={<LockOutlined />}
                loading={posting}
                disabled={draft.trim() === '' && pending.length === 0}
                onClick={() => void submit()}
              >
                {t('web.serviceDesk.conversation.addNote')}
              </Button>
            )}

            <Upload
              multiple
              showUploadList={false}
              disabled={uploading}
              beforeUpload={(file) => {
                void uploadFile(file as unknown as File);
                return false;
              }}
            >
              <Button size="middle" icon={<UploadOutlined />} loading={uploading}>
                {t('web.serviceDesk.conversation.attach')}
              </Button>
            </Upload>

            <Typography.Text type={mode === 'public' ? 'secondary' : 'warning'} style={{ fontSize: 12 }}>
              {t(
                mode === 'public'
                  ? 'web.serviceDesk.conversation.publicHint'
                  : 'web.serviceDesk.conversation.internalHint',
              )}
            </Typography.Text>
          </Space>
        </div>
      ) : composerDisabled && !denied ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
          {t('web.serviceDesk.conversation.readOnly')}
        </Typography.Text>
      ) : null}
    </Card>
  );
}

function ConversationEntry({
  item,
  definition,
  names,
}: {
  item: StreamItem;
  definition: EntityDefinition | undefined;
  names: Record<string, string>;
}) {
  if (item.type === 'Update') {
    return (
      <div className="carocrm-stream-item carocrm-conversation-system">
        <Avatar size={32} style={{ flex: '0 0 auto', background: 'var(--carocrm-c-f8ac59)' }}>
          ∆
        </Avatar>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Space size={8} wrap>
            <Tag>{t('web.serviceDesk.conversation.systemBadge')}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {new Date(item.createdAt).toLocaleString()}
            </Typography.Text>
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {updateSummary(item, definition)}
          </Typography.Paragraph>
        </div>
      </div>
    );
  }

  const internal = isInternal(item);
  const body = mentionText(item.post ?? String(item.data['notes'] ?? ''));
  return (
    <div className={`carocrm-stream-item ${internal ? 'carocrm-conversation-internal' : 'carocrm-conversation-public'}`}>
      <Avatar size={32} style={{ flex: '0 0 auto', background: internal ? 'var(--carocrm-c-fa8c16)' : 'var(--carocrm-c-438eff)' }}>
        {initialsOf(item)}
      </Avatar>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Space size={8} wrap>
          <Typography.Text strong>{authorName(item)}</Typography.Text>
          {internal ? (
            <Tag icon={<LockOutlined />} color="orange">
              {t('web.serviceDesk.conversation.internalBadge')}
            </Tag>
          ) : (
            <Tag icon={<TeamOutlined />} color="green">
              {t('web.serviceDesk.conversation.publicBadge')}
            </Tag>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {new Date(item.createdAt).toLocaleString()}
          </Typography.Text>
        </Space>
        {body !== '' ? (
          <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{body}</Typography.Paragraph>
        ) : null}
        {item.mentions.length > 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.stream.mentioned', { users: item.mentions.map(authorName2).join(', ') })}
          </Typography.Text>
        ) : null}
        {item.attachmentIds.length > 0 ? (
          <div style={{ marginTop: 4 }}>
            <Space size={6} wrap>
              {item.attachmentIds.map((id) => (
                <Tooltip key={id} title={t('web.serviceDesk.conversation.download')}>
                  <a href={`/api/v1/Attachment/${encodeURIComponent(id)}/file`} target="_blank" rel="noreferrer">
                    <PaperClipOutlined /> {names[id] ?? id}
                  </a>
                </Tooltip>
              ))}
            </Space>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function authorName2(user: { firstName: string | null; lastName: string | null; userName: string }): string {
  const full = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return full !== '' ? full : user.userName;
}
