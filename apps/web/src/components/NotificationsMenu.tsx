import { BellOutlined, CheckOutlined } from '@ant-design/icons';
import { App as AntApp, Badge, Button, Empty, Popover, Spin, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { NotificationItem } from '../api/client.js';
import { t } from '../state/i18n.js';
import { useMetadata } from '../state/metadata.js';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationList,
  useNotificationStream,
  useUnreadNotificationCount,
} from '../state/notifications.js';

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Only a same-origin path may be followed, so a stored payload cannot send the caller off-site. */
function internalLink(item: NotificationItem): string | null {
  const link = textField(item.data['link']);
  if (link !== undefined && link.startsWith('/') && !link.startsWith('//')) return link;
  // A mention carries the record instead of a link; it is the record the reader wants to open.
  const entityType = textField(item.data['entityType']);
  const entityId = textField(item.data['entityId']);
  if (entityType !== undefined && entityId !== undefined) {
    return `/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`;
  }
  return null;
}

/**
 * Header notification bell (PLAN §26).
 *
 * The badge is the server's unread count and the panel is the caller's own inbox — both are scoped
 * to the signed-in user server-side, so this component never filters rows for permissions. Reading
 * a row is an explicit action (`Read` / `Read-all`): opening the panel does not clear anything,
 * because a notification that disappears before it was read is worse than an unread one.
 *
 * Notification titles come from the writing module (`title`/`body`/`link` in the payload). A
 * mention predates that shape and only carries the record, so its title is composed from metadata.
 */
export function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const metadata = useMetadata();
  const unread = useUnreadNotificationCount();
  const inbox = useNotificationList(open);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  // New notifications arrive on their own; nothing here waits for a poll or a page reload.
  useNotificationStream();

  const unreadCount = unread.data ?? 0;
  const items = inbox.data?.list ?? [];

  const entityLabel = (entityType: string): string =>
    metadata.data?.[entityType]?.label ?? entityType;

  const titleOf = (item: NotificationItem): string => {
    const title = textField(item.data['title']);
    if (title !== undefined) return title;
    const processMessage = textField(item.data['message']);
    if (processMessage !== undefined) return processMessage;
    if (item.type === 'Mention') {
      const entityType = textField(item.data['entityType']);
      return t('web.notifications.mentionIn', {
        entity: entityType === undefined ? t('web.notifications.record') : entityLabel(entityType),
      });
    }
    return item.type;
  };

  const bodyOf = (item: NotificationItem): string | undefined => textField(item.data['body']);

  const openItem = (item: NotificationItem): void => {
    const link = internalLink(item);
    if (!item.isRead) markRead.mutate(item.id);
    if (link !== null) {
      setOpen(false);
      navigate(link);
    }
  };

  const content = (
    <div className="carocrm-notification-panel">
      <div className="carocrm-notification-head">
        <Typography.Text strong>{t('web.notifications.title')}</Typography.Text>
        <Button
          type="link"
          size="small"
          disabled={unreadCount === 0}
          loading={markAll.isPending}
          onClick={() => {
            markAll.mutate(undefined, {
              onSuccess: () => void message.success(t('web.notifications.markedAllRead')),
              onError: (error) =>
                void message.error(error instanceof Error ? error.message : t('web.notifications.markAllFailed')),
            });
          }}
        >
          {t('web.notifications.markAllRead')}
        </Button>
      </div>
      {inbox.isLoading ? (
        <div className="carocrm-notification-state">
          <Spin size="small" />
        </div>
      ) : inbox.isError ? (
        <div className="carocrm-notification-state">{t('web.notifications.loadFailed')}</div>
      ) : items.length === 0 ? (
        <Empty
          className="carocrm-notification-state"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('web.notifications.empty')}
        />
      ) : (
        <ul className="carocrm-notification-list">
          {items.map((item) => (
            <li key={item.id} className={`carocrm-notification-item${item.isRead ? '' : ' is-unread'}`}>
              <div className="carocrm-notification-main">
                <button type="button" className="carocrm-notification-title" onClick={() => openItem(item)}>
                  {titleOf(item)}
                </button>
                {bodyOf(item) === undefined ? null : (
                  <div className="carocrm-notification-text">{bodyOf(item)}</div>
                )}
                <Typography.Text type="secondary" className="carocrm-notification-time">
                  {new Date(item.createdAt).toLocaleString()}
                </Typography.Text>
              </div>
              {item.isRead ? null : (
                <Tooltip title={t('web.notifications.markRead')}>
                  <Button
                    type="text"
                    size="small"
                    className="carocrm-notification-read"
                    aria-label={t('web.notifications.markRead')}
                    icon={<CheckOutlined />}
                    loading={markRead.isPending && markRead.variables === item.id}
                    onClick={() =>
                      markRead.mutate(item.id, {
                        onError: (error) =>
                          void message.error(
                            error instanceof Error ? error.message : t('web.notifications.markReadFailed'),
                          ),
                      })
                    }
                  />
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A bell that was clicked is the cheapest moment to re-read the inbox.
        if (next) void inbox.refetch();
      }}
    >
      <button
        type="button"
        className="carocrm-notification-trigger"
        aria-label={t('web.notifications.ariaLabel', { count: String(unreadCount) })}
      >
        <Badge count={unreadCount} size="small" overflowCount={99}>
          <BellOutlined />
        </Badge>
      </button>
    </Popover>
  );
}
