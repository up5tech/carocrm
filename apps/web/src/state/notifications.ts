import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api, getStoredToken, refreshAccessToken } from '../api/client.js';

/**
 * In-app notifications (PLAN §26) behind the header bell.
 *
 * Two queries share one key prefix: the unread count the badge shows (one row, only its `total`
 * matters) and the inbox list the panel renders when it opens. Marking one or all as read
 * invalidates the prefix, so the badge and an open panel can never disagree — the server owns
 * `is_read` and both views are re-read from it instead of patched in two places.
 */
export const NOTIFICATIONS_KEY = ['notifications'] as const;
const UNREAD_KEY = [...NOTIFICATIONS_KEY, 'unread'] as const;
const LIST_KEY = [...NOTIFICATIONS_KEY, 'list'] as const;

/** The badge count. Live pushes keep it current; a window focus is only a safety net. */
export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: UNREAD_KEY,
    queryFn: () => api.notifications({ unreadOnly: true, maxSize: 1 }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // `total` is the count matching the filter, so it is exact even though one row is fetched.
    select: (result) => result.total,
  });
}

/** The inbox list, fetched only while the panel is open. */
export function useNotificationList(enabled: boolean) {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: () => api.notifications({ maxSize: 30 }),
    staleTime: 15_000,
    enabled,
  });
}

export function useMarkNotificationRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onSettled: () => client.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useMarkAllNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSettled: () => client.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

const STREAM_PATH = '/api/v1/Notification/stream';
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Keeps the inbox live: one server-sent-event stream per signed-in tab, invalidating both queries
 * whenever the server says a notification was created for this user.
 *
 * `EventSource` cannot send an Authorization header, and a token in the query string would leak it
 * into proxy and access logs, so the stream is read from an authenticated `fetch` body instead.
 * Reconnection is therefore ours too: exponential backoff, reset after a successful open, aborted
 * when the shell unmounts or the tab signs out. A 401 rotates the short-lived access token once and
 * retries, so a tab left open past the token lifetime recovers on its own.
 */
export function useNotificationStream(enabled = true): void {
  const client = useQueryClient();

  useEffect(() => {
    if (!enabled) return undefined;
    const abort = new AbortController();
    let stopped = false;
    let retryTimer: number | undefined;
    let retryDelay = INITIAL_RETRY_MS;

    const connect = async (): Promise<void> => {
      const token = getStoredToken();
      if (token === null) return;
      try {
        const response = await fetch(STREAM_PATH, {
          headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: abort.signal,
        });
        if (response.status === 401) {
          // The access token expired while the tab stayed open; rotate it and reconnect below.
          void response.body?.cancel();
          if ((await refreshAccessToken()) === null) return;
        } else if (!response.ok || response.body === null) {
          void response.body?.cancel();
          throw new Error(`notification stream failed: ${String(response.status)}`);
        } else {
          retryDelay = INITIAL_RETRY_MS;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              // The event body is not rendered; it only says "this user's inbox changed".
              if (frame.split('\n').some((line) => line.startsWith('data:'))) {
                void client.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
        }
      } catch {
        // Network hiccup or a server restart: fall through to the backoff below.
        if (abort.signal.aborted) return;
      }
      if (stopped) return;
      retryTimer = window.setTimeout(() => {
        void connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    };

    void connect();
    return () => {
      stopped = true;
      abort.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [client, enabled]);
}
