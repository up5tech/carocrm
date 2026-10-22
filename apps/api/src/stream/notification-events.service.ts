import { log } from '@carocrm/core/logger/index.js';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';

/**
 * The event the database publishes when a notification row is inserted (migration 063).
 *
 * It carries no payload beyond the recipient and the row identity on purpose: the SPA re-reads the
 * notifications it is authorised for instead of rendering whatever a channel message claims.
 */
export interface NotificationEvent {
  readonly userId: string;
  readonly id: string;
  readonly type: string;
}

const CHANNEL = 'crm_notifications';
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

@Injectable()
export class NotificationEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly subscribers = new Map<string, Set<(event: NotificationEvent) => void>>();
  private client: Client | null = null;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private listening = false;
  private closed = false;
  private readonly readyWaiters: Array<() => void> = [];

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {}

  onModuleInit(): void {
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const client = this.client;
    this.client = null;
    this.subscribers.clear();
    this.resolveReady();
    if (client !== null) await client.end().catch(() => undefined);
  }

  /**
   * Subscribes a live stream to the notifications addressed to one user.
   *
   * Returns the unsubscribe function; the caller must call it when the connection closes, or the
   * listener would keep receiving events for a client that is gone.
   */
  subscribe(userId: string, listener: (event: NotificationEvent) => void): () => void {
    let listeners = this.subscribers.get(userId);
    if (listeners === undefined) {
      listeners = new Set();
      this.subscribers.set(userId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(userId);
    };
  }

  /** Resolves once `LISTEN` is active, so a caller can know the channel is attached. */
  whenReady(): Promise<void> {
    if (this.listening) return Promise.resolve();
    return new Promise<void>((resolve) => this.readyWaiters.push(resolve));
  }

  private resolveReady(): void {
    this.listening = true;
    for (const resolve of this.readyWaiters.splice(0)) resolve();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const client = new Client({ connectionString: this.config.databaseUrl });
    this.client = client;
    client.on('notification', (message) => {
      if (message.channel === CHANNEL && message.payload !== undefined) this.dispatch(message.payload);
    });
    // A dropped listen connection must never take the API down with it: log the cause, then retry
    // with backoff so live updates recover without a restart.
    client.on('error', (error: Error) => {
      log.warn({ err: error.message }, 'notification channel error');
      this.scheduleReconnect();
    });
    client.on('end', () => this.scheduleReconnect());
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.reconnectDelay = INITIAL_RECONNECT_MS;
      this.resolveReady();
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'notification channel unavailable');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    const client = this.client;
    this.client = null;
    this.listening = false;
    if (client !== null) void client.end().catch(() => undefined);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    timer.unref();
    this.reconnectTimer = timer;
  }

  private dispatch(raw: string): void {
    const event = parseEvent(raw);
    if (event === undefined) return;
    const listeners = this.subscribers.get(event.userId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn({ err: error instanceof Error ? error.message : String(error) }, 'notification subscriber failed');
      }
    }
  }
}

/** The trigger's JSON is trusted shape-wise but parsed defensively: a malformed message is dropped. */
function parseEvent(raw: string): NotificationEvent | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof NotificationEvent, unknown>>;
    const { userId, id, type } = parsed;
    if (typeof userId !== 'string' || typeof id !== 'string' || typeof type !== 'string') return undefined;
    return { userId, id, type };
  } catch {
    return undefined;
  }
}
