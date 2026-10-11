import { DeleteOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import { App as AntApp, Avatar, Button, Card, Empty, Input, Space, Spin, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { api, type StreamItem } from '../api/client.js';
import type { EntityDefinition } from '../api/types.js';
import { fieldLabel } from '../state/metadata.js';

const { TextArea } = Input;

function initialsOf(item: StreamItem): string {
  const name = item.createdBy;
  const first = name?.firstName ?? name?.userName ?? '?';
  return first.slice(0, 2).toUpperCase();
}

function authorOf(item: StreamItem): string {
  const name = item.createdBy;
  if (!name) return 'Unknown user';
  const full = `${name.firstName ?? ''} ${name.lastName ?? ''}`.trim();
  return full !== '' ? full : name.userName;
}

function mentionText(text: string): string {
  return text.replace(/@\[([^\]]+)\]/g, '@$1');
}

/** Human sentence for a generated `Update` item (PLAN §26 record updates). */
export function updateSummary(item: StreamItem, definition: EntityDefinition | undefined): string {
  const attributes = Array.isArray(item.data['attributes']) ? (item.data['attributes'] as Array<Record<string, unknown>>) : [];
  if (attributes.length === 0) return 'Record updated.';
  return attributes
    .map((attribute) => {
      const name = String(attribute['name'] ?? '');
      const label = fieldLabel(name, definition?.fields[name]);
      const value = attribute['value'];
      const shown = value === null || value === undefined || value === '' ? 'empty' : String(value);
      return `${label} → ${shown}`;
    })
    .join(', ');
}

export function StreamItemRow({ item, definition, onDelete }: {
  item: StreamItem;
  definition: EntityDefinition | undefined;
  onDelete?: ((id: string) => void) | undefined;
}) {
  const body = item.type === 'Update' ? updateSummary(item, definition) : mentionText(item.post ?? String(item.data['notes'] ?? ''));
  return (
    <div className="lizant-stream-item">
      <Avatar size={32} style={{ flex: '0 0 auto', background: item.type === 'Update' ? '#f8ac59' : '#438eff' }}>
        {item.type === 'Update' ? '∆' : initialsOf(item)}
      </Avatar>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Space size={8} wrap>
          <Typography.Text strong>{item.type === 'Update' ? 'System update' : authorOf(item)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {new Date(item.createdAt).toLocaleString()}
          </Typography.Text>
          {onDelete ? (
            <Button size="small" type="text" danger aria-label="Delete post" icon={<DeleteOutlined />} onClick={() => onDelete(item.id)} />
          ) : null}
        </Space>
        <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{body}</Typography.Paragraph>
        {item.mentions.length > 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            mentioned {item.mentions.map(mentionText2).join(', ')}
          </Typography.Text>
        ) : null}
      </div>
    </div>
  );
}

function mentionText2(user: { firstName: string | null; lastName: string | null; userName: string }): string {
  const full = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return full !== '' ? full : user.userName;
}

/**
 * Record timeline (PLAN §26): posts + generated updates, follow toggle and composer.
 * The composer is only shown when `canPost`; the backend still enforces the `stream` action.
 */
export function StreamPanel({ entity, id, definition, canPost }: {
  entity: string;
  id: string;
  definition: EntityDefinition | undefined;
  canPost: boolean;
}) {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<StreamItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [followed, setFollowed] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [stream, status] = await Promise.all([api.streamFor(entity, id, { maxSize: 50 }), api.isFollowed(entity, id)]);
      setItems(stream.list);
      setFollowed(status.followed);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Failed to load the stream.');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [entity, id, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (text === '') return;
    setPosting(true);
    try {
      await api.postNote(entity, id, text);
      setDraft('');
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Failed to post.');
    } finally {
      setPosting(false);
    }
  };

  const toggleFollow = async (): Promise<void> => {
    try {
      if (followed) {
        await api.unfollow(entity, id);
        setFollowed(false);
      } else {
        await api.follow(entity, id);
        setFollowed(true);
      }
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Failed to change the follow state.');
    }
  };

  const remove = async (itemId: string): Promise<void> => {
    try {
      await api.deleteNote(itemId);
      await load();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'Failed to delete the post.');
    }
  };

  return (
    <Card
      className="lizant-card"
      title={<Typography.Text strong>Stream</Typography.Text>}
      extra={
        <Button size="small" type="text" icon={followed ? <StarFilled style={{ color: '#f8ac59' }} /> : <StarOutlined />} onClick={() => void toggleFollow()}>
          {followed ? 'Following' : 'Follow'}
        </Button>
      }
    >
      {loading && items.length === 0 ? (
        <Spin />
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No activity yet" />
      ) : (
        <div className="lizant-stream-list">
          {items.map((item) => (
            <StreamItemRow
              key={item.id}
              item={item}
              definition={definition}
              onDelete={item.type === 'Update' ? undefined : remove}
            />
          ))}
        </div>
      )}
      {canPost ? (
        <div style={{ marginTop: 12 }}>
          <TextArea
            rows={2}
            value={draft}
            placeholder="Write to the stream. Use @ to mention a colleague."
            onChange={(event) => setDraft(event.target.value)}
            onPressEnter={(event) => {
              if (event.metaKey || event.ctrlKey) void submit();
            }}
          />
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" loading={posting} disabled={draft.trim() === ''} onClick={() => void submit()}>
              Post
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ⌘/Ctrl + Enter to post
            </Typography.Text>
          </Space>
        </div>
      ) : null}
    </Card>
  );
}
