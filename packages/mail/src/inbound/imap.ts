/**
 * IMAP inbound provider (Phase 24.6 task 1).
 *
 * Speaks a deliberately small IMAP subset over TLS (`node:net`/`node:tls` only — no new
 * dependency): LOGIN, SELECT (captures UIDVALIDITY), UID SEARCH SINCE, and UID FETCH of
 * `BODY.PEEK[]` (never `\Seen`-setting `BODY[]`). The provider-stable identity is
 * `UIDVALIDITY:UID`, so a mailbox that resets its UID space yields fresh identities instead
 * of colliding with the previous epoch.
 *
 * Cursor: `{ uidValidity, lastUid }`. A stored UIDVALIDITY different from the server's means
 * the mailbox was rebuilt: the cursor is discarded and the poll starts fresh (dedupe keeps it
 * safe). Messages larger than `maxMessageBytes` are skipped with a `parsedMessage` fallback
 * carrying `isMalformed`, so one giant message cannot stall the mailbox.
 *
 * Plaintext (`secure: false`) exists only for loopback/test servers: the settings parser
 * refuses non-loopback hosts without TLS.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import { InboundMailError, type InboundMailMessage, type InboundMailProvider, type InboundPollOptions } from './index.js';
import { parseMimeMessage } from './mime.js';

export interface ImapSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  mailbox: string;
  maxMessageBytes: number;
  connectTimeoutMs: number;
}

const DEFAULTS = { port: 993, secure: true, mailbox: 'INBOX', maxMessageBytes: 10 * 1024 * 1024, connectTimeoutMs: 15_000 } as const;

function requiredString(raw: Record<string, string | undefined>, key: string, message: string): string {
  const value = (raw[key] ?? '').trim();
  if (value === '') throw new InboundMailError('invalid_config', message);
  return value;
}

/** Parses `IMAP_*` environment-style settings; called at boot so bad config fails before the first poll. */
export function parseImapSettings(raw: Record<string, string | undefined>): ImapSettings {
  const host = requiredString(raw, 'IMAP_HOST', 'IMAP_HOST is required when MAIL_INBOUND_PROVIDER=imap.');
  const username = requiredString(raw, 'IMAP_USERNAME', 'IMAP_USERNAME is required when MAIL_INBOUND_PROVIDER=imap.');
  const password = requiredString(raw, 'IMAP_PASSWORD', 'IMAP_PASSWORD is required when MAIL_INBOUND_PROVIDER=imap.');
  const secureRaw = (raw['IMAP_SECURE'] ?? '').trim().toLowerCase();
  const secure = secureRaw === '' ? true : secureRaw !== 'false';
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  if (!secure && !loopback) {
    throw new InboundMailError('invalid_config', 'IMAP_SECURE must be true for a non-loopback IMAP host.');
  }
  return {
    host,
    port: Number(raw['IMAP_PORT'] ?? DEFAULTS.port) || DEFAULTS.port,
    secure,
    username,
    password,
    mailbox: (raw['IMAP_MAILBOX'] ?? DEFAULTS.mailbox).trim() || DEFAULTS.mailbox,
    maxMessageBytes: Number(raw['MAIL_MAX_INBOUND_MESSAGE_BYTES'] ?? DEFAULTS.maxMessageBytes) || DEFAULTS.maxMessageBytes,
    connectTimeoutMs: DEFAULTS.connectTimeoutMs,
  };
}

interface CursorState {
  uidValidity: string;
  lastUid: number;
}

function decodeCursor(raw: string | null | undefined): CursorState | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CursorState>;
    if (typeof parsed['uidValidity'] === 'string' && typeof parsed['lastUid'] === 'number') {
      return { uidValidity: parsed['uidValidity'], lastUid: parsed['lastUid'] };
    }
  } catch {
    // A corrupted cursor is discarded rather than trusted; dedupe keeps a re-poll safe.
  }
  return null;
}

function encodeCursor(state: CursorState): string {
  return JSON.stringify(state);
}

export interface ImapConnectionFactory {
  (settings: ImapSettings): Promise<SocketLike>;
}

/** The slice of a socket the IMAP session needs; tests inject a fake without node:net. */
export interface SocketLike {
  write(data: string): void;
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  destroy(): void;
}

export class ImapInboundProvider implements InboundMailProvider {
  readonly name = 'imap';
  readonly configured = true;
  readonly connectionId: string;
  private cursorOut: string | null = null;
  private readonly factory: ImapConnectionFactory | undefined;

  constructor(
    private readonly settings: ImapSettings,
    options: { connectionId?: string | undefined; connect?: ImapConnectionFactory | undefined } = {},
  ) {
    this.connectionId = options.connectionId ?? `imap:${settings.host}:${settings.mailbox}`;
    this.factory = options.connect;
  }

  nextCursor(): string | null {
    return this.cursorOut;
  }

  async poll(options: InboundPollOptions = {}): Promise<InboundMailMessage[]> {
    const maxMessages = Math.max(1, Math.min(options.maxMessages ?? 50, 500));
    const stored = decodeCursor(options.cursor);
    const session = await this.connect();
    try {
      await session.login(this.settings.username, this.settings.password);
      const selected = await session.select(this.settings.mailbox);
      const messages = await session.fetchSince(stored, selected, maxMessages, this.settings.maxMessageBytes);
      // Cursor moves only after a fully successful fetch, keyed by UIDVALIDITY so an epoch
      // change is visible to the next poll instead of silently resuming into a dead UID space.
      const lastMessage = messages[messages.length - 1];
      if (lastMessage !== undefined && Number.isFinite(providerUid(lastMessage))) {
        this.cursorOut = encodeCursor({ uidValidity: selected.uidValidity, lastUid: providerUid(lastMessage) });
      }
      return messages;
    } finally {
      session.close();
    }
  }

  private async connect(): Promise<ImapSession> {
    const connectFn = this.factory ?? defaultConnect();
    let socket: SocketLike;
    try {
      socket = await connectFn(this.settings);
    } catch (error: unknown) {
      if (error instanceof InboundMailError) throw error;
      throw new InboundMailError('connection_failed', `Could not connect to IMAP server ${this.settings.host}:${this.settings.port}.`);
    }
    return new ImapSession(socket, this.settings.connectTimeoutMs);
  }
}

function defaultConnect(): ImapConnectionFactory {
  return (requested: ImapSettings) =>
    new Promise<SocketLike>((resolve, reject) => {
      const socket: Socket = requested.secure
        ? (tlsConnect({ host: requested.host, port: requested.port, servername: requested.host }) as unknown as Socket)
        : netConnect({ host: requested.host, port: requested.port });
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        resolve(socket as unknown as SocketLike);
      });
    });
}

/**
 * One IMAP session. Protocol notes: responses are tag-prefixed for commands; untagged lines
 * carry literals (`{n}`) that must be consumed as raw bytes before the next line is read.
 * Only the `BODY.PEEK[]` literal is interpreted — everything else is ignored.
 */
export class ImapSession {
  private buffer = Buffer.alloc(0);
  private tagCounter = 0;
  private closed = false;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(
    private readonly socket: SocketLike,
    private readonly timeoutMs = 15_000,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (const waiter of this.waiters.splice(0)) waiter.resolve();
    });
    socket.on('close', () => this.failAll('connection_closed', 'The IMAP connection closed unexpectedly.'));
    socket.on('error', () => this.failAll('connection_failed', 'The IMAP connection failed.'));
  }

  async login(username: string, password: string): Promise<void> {
    await this.readLine(); // server greeting `* OK ...`
    const result = await this.command('LOGIN', [`"${escape(username)}"`, `"${escape(password)}"`]);
    if (result.state !== 'OK') throw new InboundMailError('auth_failed', 'IMAP login failed; check the mailbox credentials.');
  }

  async select(mailbox: string): Promise<{ uidValidity: string; exists: number }> {
    const result = await this.command('SELECT', [`"${escape(mailbox)}"`]);
    if (result.state !== 'OK') throw new InboundMailError('protocol_error', `Could not open IMAP mailbox "${mailbox}".`);
    let uidValidity = '0';
    let exists = 0;
    for (const line of result.untagged) {
      const validity = /\* OK \[UIDVALIDITY (\d+)\]/.exec(line);
      if (validity !== null) uidValidity = String(validity[1]);
      const count = /^\* (\d+) EXISTS/.exec(line);
      if (count !== null) exists = Number(count[1]);
    }
    return { uidValidity, exists };
  }

  /** Fetches UIDs newer than the cursor, oldest first, capped by `maxMessages` and `maxMessageBytes`. */
  async fetchSince(
    stored: CursorState | null,
    selected: { uidValidity: string },
    maxMessages: number,
    maxMessageBytes: number,
  ): Promise<InboundMailMessage[]> {
    const fromDate = new Date();
    const searchArgs = stored === null ? ['ALL'] : ['SINCE', imapDate(fromDate)];
    const search = await this.command('UID', ['SEARCH', ...searchArgs]);
    const uids = parseUidSearch(search.untagged);
    const fresh = stored === null ? uids : uids.filter((uid) => uid > stored.lastUid);
    const batch = fresh.slice(0, maxMessages);
    if (batch.length === 0) return [];

    const messages: InboundMailMessage[] = [];
    const seen = new Set<number>();
    for (let start = 0; start < batch.length; start += 50) {
      const slice = batch.slice(start, start + 50).join(',');
      const fetch = await this.command('UID', ['FETCH', slice, '(UID BODY.PEEK[])']);
      const literalQueue = fetch.literals;
      for (const line of fetch.untagged) {
        const match = /FETCH \(UID (\d+) BODY\[\]/i.exec(line);
        if (match === null) continue;
        const uid = Number(match[1]);
        if (seen.has(uid)) continue;
        seen.add(uid);
        const chunk = literalQueue.shift() ?? Buffer.alloc(0);
        messages.push(normalizeRaw(uid, selected.uidValidity, chunk, maxMessageBytes));
      }
    }
    return messages.sort((a, b) => providerUid(a) - providerUid(b));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write('LOGOUT\r\n');
    } catch {
      // Best effort: the session is already dead.
    }
    this.socket.destroy();
  }

  private async command(verb: string, args: string[]): Promise<{ state: string; untagged: string[]; literals: Buffer[] }> {
    this.tagCounter += 1;
    const tag = `A${String(this.tagCounter).padStart(3, '0')}`;
    this.socket.write(`${tag} ${verb} ${args.join(' ')}\r\n`);
    const lines = await this.readUntilTagged(tag);
    const literals: Buffer[] = [];
    const untagged: string[] = [];
    let state = '';
    for (const entry of lines) {
      if (entry.kind === 'line') {
        if (entry.text.startsWith(`${tag} `)) state = entry.text.split(' ')[1] ?? '';
        else untagged.push(entry.text);
      } else {
        literals.push(entry.bytes);
      }
    }
    return { state, untagged, literals };
  }

  /** Waits until at least one `data`/`error` event, honoring the session timeout. */
  private waitForData(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new InboundMailError('timeout', 'Timed out waiting for the IMAP server.'));
      }, this.timeoutMs);
      this.waiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private failAll(code: string, message: string): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(new InboundMailError(code, message));
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const index = this.buffer.indexOf(Buffer.from('\r\n'));
      if (index >= 0) {
        const line = this.buffer.subarray(0, index).toString('utf8');
        this.buffer = this.buffer.subarray(index + 2);
        return line;
      }
      await this.waitForData();
    }
  }

  private async readBytes(size: number): Promise<Buffer> {
    for (;;) {
      if (this.buffer.length >= size) {
        const bytes = Buffer.from(this.buffer.subarray(0, size));
        this.buffer = this.buffer.subarray(size);
        return bytes;
      }
      await this.waitForData();
    }
  }

  private async readUntilTagged(tag: string): Promise<Array<{ kind: 'line'; text: string } | { kind: 'literal'; bytes: Buffer }>> {
    const entries: Array<{ kind: 'line'; text: string } | { kind: 'literal'; bytes: Buffer }> = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        entries.push({ kind: 'line', text: line });
        return entries;
      }
      entries.push({ kind: 'line', text: line });
      // Literal: line ends `{n}`. Consume exactly n bytes (the FETCH body) as the next entry.
      const literal = /\{(\d+)\}\s*$/.exec(line);
      if (literal !== null) {
        const size = Number(literal[1]);
        const bytes = await this.readBytes(size);
        entries.push({ kind: 'literal', bytes });
      }
    }
  }
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function imapDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${day}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function parseUidSearch(untagged: string[]): number[] {
  const uids: number[] = [];
  for (const line of untagged) {
    const match = /^\* SEARCH(?:\s+(.*))?$/.exec(line);
    if (match === null || match[1] === undefined) continue;
    for (const token of match[1].split(/\s+/)) {
      const uid = Number(token);
      if (Number.isInteger(uid) && uid > 0) uids.push(uid);
    }
  }
  return uids.sort((a, b) => a - b);
}

function providerUid(message: InboundMailMessage): number {
  const index = message.providerMessageId.indexOf(':');
  return Number(message.providerMessageId.slice(index + 1)) || 0;
}

function normalizeRaw(uid: number, uidValidity: string, chunk: Buffer, maxMessageBytes: number): InboundMailMessage {
  const providerMessageId = `${uidValidity}:${uid}`;
  if (chunk.length > maxMessageBytes) {
    return fallbackMessage(providerMessageId, uidValidity, `message exceeds ${maxMessageBytes} bytes`);
  }
  const { parsed, malformed, parseError } = parseMimeMessage(chunk);
  if (malformed) {
    return {
      providerMessageId,
      threadId: parsed.messageId ?? null,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject === '' ? '(no subject)' : parsed.subject,
      text: parsed.text === '' ? '(message could not be parsed)' : parsed.text,
      html: parsed.html,
      receivedAt: parsed.receivedAt ?? new Date(),
      inReplyTo: parsed.inReplyTo,
      headers: parsed.headers,
      attachments: parsed.attachments,
      messageKind: parsed.messageKind,
      isMalformed: true,
      parseError,
    };
  }
  return {
    providerMessageId,
    threadId: parsed.messageId ?? parsed.references[parsed.references.length - 1] ?? null,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject === '' ? '(no subject)' : parsed.subject,
    text: parsed.text,
    html: parsed.html,
    receivedAt: parsed.receivedAt ?? new Date(),
    inReplyTo: parsed.inReplyTo,
    headers: parsed.headers,
    attachments: parsed.attachments,
    messageKind: parsed.messageKind,
  };
}

function fallbackMessage(providerMessageId: string, _uidValidity: string, reason: string): InboundMailMessage {
  return {
    providerMessageId,
    threadId: null,
    from: { name: null, address: 'unknown' },
    to: [],
    cc: [],
    subject: '(unparsed inbound message)',
    text: `(message could not be parsed: ${reason.slice(0, 200)})`,
    html: null,
    receivedAt: new Date(),
    inReplyTo: null,
    headers: {},
    attachments: [],
    messageKind: 'standard',
    isMalformed: true,
    parseError: reason,
  };
}
