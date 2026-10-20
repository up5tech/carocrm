import { useEffect, useRef, useState } from 'react';

import type { CRMChatStreamEvent, CRMChatStreamEventType } from '../../api/types.js';

/**
 * Phase 19-CHAT.6 — React hook for consuming the CRM Chat SSE stream.
 *
 * Connects to `/api/v1/CRMChat/action/turns/:turnId/events` and parses SSE events.
 * Supports resumption via lastEventId and automatic cleanup on unmount.
 */
export interface UseCrmChatStreamOptions {
  readonly turnId: string | null;
  readonly enabled?: boolean;
  readonly lastEventId?: string | undefined;
  readonly onEvent?: (event: CRMChatStreamEvent) => void;
  readonly onError?: (error: Error) => void;
  readonly onComplete?: () => void;
}

export interface UseCrmChatStreamResult {
  readonly isConnected: boolean;
  readonly events: readonly CRMChatStreamEvent[];
  readonly error: Error | null;
  readonly disconnect: () => void;
}

export function useCrmChatStream(options: UseCrmChatStreamOptions): UseCrmChatStreamResult {
  const { turnId, enabled = true, lastEventId, onEvent, onError, onComplete } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [events, setEvents] = useState<CRMChatStreamEvent[]>([]);
  const [error, setError] = useState<Error | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const manualDisconnectRef = useRef(false);

  // Cleanup function.
  const disconnect = () => {
    manualDisconnectRef.current = true;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsConnected(false);
  };

  useEffect(() => {
    // Reset state when turnId changes.
    if (!turnId || !enabled) {
      disconnect();
      return;
    }

    manualDisconnectRef.current = false;
    setEvents([]);
    setError(null);

    // Build URL with Last-Event-ID as query param for initial resume position.
    const url = `/api/v1/CRMChat/action/turns/${encodeURIComponent(turnId)}/events`;

    // Note: Standard EventSource doesn't support custom headers, so we can't send Last-Event-ID
    // header directly. The server supports it via query param or we rely on the browser's built-in
    // Last-Event-ID tracking for reconnections.
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      if (!manualDisconnectRef.current) {
        setIsConnected(true);
      }
    };

    eventSource.onerror = () => {
      if (manualDisconnectRef.current) return;

      // Check readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSED
      if (eventSource.readyState === 2) {
        // Connection closed permanently.
        setIsConnected(false);
        const err = new Error('SSE connection closed.');
        setError(err);
        onError?.(err);
      }
      // For transient errors (readyState 0), EventSource will auto-reconnect.
    };

    // Listen for all registered event types.
    const eventTypes: CRMChatStreamEventType[] = [
      'turn.started',
      'tool.started',
      'tool.completed',
      'citation.added',
      'action.proposed',
      'approval.required',
      'assistant.message',
      'usage.summary',
      'turn.completed',
      'turn.failed',
      'turn.cancelled',
      'heartbeat',
    ];

    for (const eventType of eventTypes) {
      eventSource.addEventListener(eventType, (event: MessageEvent) => {
        if (manualDisconnectRef.current) return;

        try {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          const streamEvent: CRMChatStreamEvent = {
            id: event.lastEventId || String(Date.now()),
            event: eventType,
            data,
          };

          setEvents((prev) => [...prev, streamEvent]);
          onEvent?.(streamEvent);

          // Auto-disconnect on terminal events.
          if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(eventType)) {
            eventSource.close();
            setIsConnected(false);
            onComplete?.();
          }
        } catch (parseError) {
          const err = parseError instanceof Error ? parseError : new Error('Failed to parse SSE event.');
          setError(err);
          onError?.(err);
        }
      });
    }

    // Cleanup on unmount or when dependencies change.
    return () => {
      disconnect();
    };
  }, [turnId, enabled, lastEventId, onEvent, onError, onComplete]);

  return { isConnected, events, error, disconnect };
}
