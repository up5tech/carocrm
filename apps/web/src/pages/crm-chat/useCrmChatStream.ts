import { useCallback, useEffect, useRef, useState } from 'react';

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

  // The callbacks are supplied inline by the composer; keeping them in refs stops every render
  // (including every streamed event) from tearing down and reopening the EventSource.
  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Cleanup function.
  const disconnect = useCallback(() => {
    const source = eventSourceRef.current;
    eventSourceRef.current = null;
    source?.close();
    setIsConnected(false);
  }, []);

  useEffect(() => {
    // Reset state when turnId changes.
    if (!turnId || !enabled) {
      disconnect();
      return;
    }

    let disposed = false;
    let sawTerminal = false;
    let sawAssistantMessage = false;

    setEvents([]);
    setError(null);

    // Build URL with Last-Event-ID as query param for initial resume position.
    const url = `/api/v1/CRMChat/action/turns/${encodeURIComponent(turnId)}/events`;

    // Note: Standard EventSource doesn't support custom headers, so we can't send Last-Event-ID
    // header directly. The server supports it via query param or we rely on the browser's built-in
    // Last-Event-ID tracking for reconnections.
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;
    // An old source can outlive its render (for example React's development StrictMode cleanup).
    // Its late error callback must not tear down the current turn or surface a false failure.
    const isCurrent = () => !disposed && eventSourceRef.current === eventSource;

    eventSource.onopen = () => {
      if (isCurrent()) setIsConnected(true);
    };

    eventSource.onerror = () => {
      if (!isCurrent()) return;

      // Check readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSED
      if (eventSource.readyState === 2) {
        eventSourceRef.current = null;
        setIsConnected(false);

        // The server deliberately ends a completed response. The browser can report that normal
        // close as an error before the last buffered event is dispatched, so never show a transport
        // error once the answer or terminal state has already arrived. The composer refreshes the
        // saved history on complete.
        if (sawTerminal || sawAssistantMessage) {
          eventSource.close();
          onCompleteRef.current?.();
          return;
        }

        // Connection closed permanently without a terminal event.
        eventSource.close();
        const err = new Error('SSE connection closed.');
        setError(err);
        onErrorRef.current?.(err);
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
        if (!isCurrent()) return;

        try {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          const streamEvent: CRMChatStreamEvent = {
            id: event.lastEventId || String(Date.now()),
            event: eventType,
            data,
          };

          setEvents((prev) => [...prev, streamEvent]);
          onEventRef.current?.(streamEvent);

          if (eventType === 'assistant.message') sawAssistantMessage = true;

          // Auto-disconnect on terminal events.
          if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(eventType)) {
            sawTerminal = true;
            eventSourceRef.current = null;
            eventSource.close();
            setIsConnected(false);
            onCompleteRef.current?.();
          }
        } catch (parseError) {
          if (!isCurrent()) return;
          const err = parseError instanceof Error ? parseError : new Error('Failed to parse SSE event.');
          setError(err);
          onErrorRef.current?.(err);
        }
      });
    }

    // Cleanup on unmount or when dependencies change.
    return () => {
      disposed = true;
      if (eventSourceRef.current === eventSource) {
        eventSourceRef.current = null;
        eventSource.close();
        setIsConnected(false);
      }
    };
  }, [turnId, enabled, lastEventId, disconnect]);

  return { isConnected, events, error, disconnect };
}
