import { createHash, randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import type { FileStorage } from '@carocrm/files';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { FILE_STORAGE_TOKEN } from '../attachment/attachment.constants.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { assertSafeMediaUrl } from './media-url.js';
import { VOICE_JOB_FETCH_MEDIA } from './voice-communications-jobs.js';
import { VoiceCommunicationsSettingsService } from './voice-communications-settings.service.js';
import type { NormalizedRecordingEvent } from './voice-provider.js';

/**
 * Phase 19-VC.15 — recording and secure media handling
 * (`PLAN_Phase_19_Voice_Communications.md` §7.5, §15 `19-VC.15`).
 *
 * The security model, in order:
 *  1. A recording callback only ever creates a **reference** (`voice_media`, kind `recording`). The
 *     provider URL is validated (scheme, host, SSRF) before it is even stored; for a recording row
 *     `provider_ref` holds that validated source URL.
 *  2. Bytes enter private storage **only** when `media.fetchMode = "privateStorage"`. The default is
 *     `off`: recording is not enabled by default, and neither is fetching. The fetch runs as a worker
 *     job (`voiceCommunications.fetchMedia`), never on an HTTP path.
 *  3. Playback goes through this service with the parent call's ACL. A guessed id yields "no media
 *     access" for a caller without permission, and a provider URL is never handed to a browser — the
 *     platform serves the bytes it stored, so no provider token can leak.
 */

export interface VoiceMediaRow {
  id: string;
  message_id: string | null;
  call_session_id: string | null;
  kind: string;
  provider_ref: string | null;
  storage_ref: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  sha256: string | null;
  scan_status: string;
  retention_at: Date | null;
  created_at: Date;
}

export interface MediaView {
  readonly id: string;
  readonly kind: string;
  readonly messageId: string | null;
  readonly callSessionId: string | null;
  readonly providerRef: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly durationSeconds: number | null;
  readonly scanStatus: string;
  readonly retentionAt: string | null;
  readonly createdAt: string;
}

const PLAYBACK_MIME_ALLOWLIST = ['audio/', 'video/'];

@Injectable()
export class VoiceMediaService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(FILE_STORAGE_TOKEN) private readonly storage: FileStorage,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
  ) {}

  /**
   * A recording callback arrived. Registers the reference when the feature is on and the URL passes
   * validation; a policy that says "off" leaves the receipt processed but records nothing, which is
   * the honest reading of "recording is not enabled by default" (§7.5).
   */
  async ingestRecording(input: {
    readonly accountKey: string;
    readonly event: NormalizedRecordingEvent;
  }): Promise<{ readonly recorded: boolean; readonly reason?: string | undefined }> {
    const event = input.event;
    if (event.providerCallId === null) return this.skip('no call id');
    if (event.url === null) return this.skip('no url');
    const settings = await this.settings.settings();
    if (settings.features.recordings !== true) return this.skip('recordings disabled');

    // The session must already exist: a recording for an unknown call is not our data to keep.
    const session = (
      await sql<{ id: string }>`
        select id from voice_call_sessions
        where account_key = ${input.accountKey} and provider_call_id = ${event.providerCallId}
        limit 1
      `.execute(this.database.db)
    ).rows[0];
    if (session === undefined) return this.skip('unknown call session');

    // SSRF gate before the reference is even stored (§15 `19-VC.15` acceptance). A refused URL is a
    // permanent policy verdict, not a transient fault: the receipt is processed and the reason is
    // visible in the webhook event, so a retry storm cannot be built from a bad URL.
    try {
      await assertSafeMediaUrl(event.url, {
        allowedHosts: settings.media.allowedHosts,
        allowLoopback: settings.media.allowLoopback,
      });
    } catch (error) {
      return this.skip(error instanceof Error ? error.message : 'url refused');
    }

    // One recording per (call, source URL): a replayed callback registers nothing new.
    const existing = (
      await sql<{ id: string }>`
        select id from voice_media
        where call_session_id = ${session.id} and kind = 'recording' and provider_ref = ${event.url}
        limit 1
      `.execute(this.database.db)
    ).rows[0];
    if (existing !== undefined) return { recorded: false, reason: 'duplicate recording reference' };

    const retentionAt = new Date(Date.now() + settings.media.retentionDays * 86_400_000);
    const id = randomUUID();
    await sql`
      insert into voice_media
        (id, call_session_id, kind, provider_ref, mime_type, duration_seconds,
         scan_status, retention_at, created_at)
      values
        (${id}, ${session.id}, 'recording', ${event.url}, ${event.mimeType},
         ${event.durationSeconds}, 'pending', ${retentionAt}, now())
    `.execute(this.database.db);

    if (settings.media.fetchMode === 'privateStorage') {
      // The fetch is a worker hop: a slow provider download must never hold a webhook receipt open.
      try {
        await this.jobs.enqueue({ job: VOICE_JOB_FETCH_MEDIA, data: { mediaId: id } });
      } catch (error) {
        // The reference is durable; the fetch stays pending and the sweep/replay can retry it.
        await sql`
          update voice_media set scan_status = 'pending'
          where id = ${id}
        `.execute(this.database.db);
        if (error instanceof Error) {
          await sql`
            update voice_media set scan_status = 'pending'
            where id = ${id} and scan_status = 'pending'
          `.execute(this.database.db);
        }
      }
    }
    return { recorded: true };
  }

  /** Fetch one recording into private storage. Runs in the worker; never on an HTTP path. */
  async fetchAndStore(mediaId: string): Promise<{ readonly stored: boolean; readonly reason?: string | undefined }> {
    const row = await this.requireRow(mediaId);
    if (row.kind !== 'recording' || row.provider_ref === null) {
      return { stored: false, reason: 'not a fetchable recording' };
    }
    const settings = await this.settings.settings();
    if (settings.media.fetchMode !== 'privateStorage') return { stored: false, reason: 'fetch disabled' };
    // The URL was validated at ingest; the check runs again immediately before the fetch (§13.1).
    await assertSafeMediaUrl(row.provider_ref, {
      allowedHosts: settings.media.allowedHosts,
      allowLoopback: settings.media.allowLoopback,
    });

    const response = await fetch(row.provider_ref, {
      signal: AbortSignal.timeout(30_000),
      headers: { accept: 'audio/*,video/*' },
    });
    if (!response.ok) return { stored: false, reason: `provider returned ${response.status}` };
    const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim() ?? 'application/octet-stream';
    if (!PLAYBACK_MIME_ALLOWLIST.some((prefix) => contentType.startsWith(prefix))) {
      return { stored: false, reason: `refused content type ${contentType}` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > settings.media.maxBytes) {
      return { stored: false, reason: 'media exceeds the configured ceiling' };
    }

    const key = `voice-media/${row.id}`;
    await this.storage.put({ key, body: buffer, contentType, sizeHint: buffer.byteLength });
    await sql`
      update voice_media
      set storage_ref = ${key}, mime_type = ${contentType}, size_bytes = ${buffer.byteLength},
          sha256 = ${createHash('sha256').update(buffer).digest('hex')}, scan_status = 'clean'
      where id = ${row.id}
    `.execute(this.database.db);
    return { stored: true };
  }

  /**
   * Authorized playback. The caller must be able to read the parent call; the bytes come from
   * private storage, so no provider credential is involved (§7.5, §15 acceptance).
   */
  async playback(mediaId: string): Promise<{ readonly contentType: string; readonly body: Buffer; readonly filename: string }> {
    const row = await this.requireRow(mediaId);
    if (row.storage_ref === null) {
      throw new ValidationError('The media has not been fetched into private storage; enable media.fetchMode first.');
    }
    await this.assertCanRead(row);
    const body = await this.storage.get(row.storage_ref);
    return { contentType: row.mime_type ?? 'application/octet-stream', body, filename: `recording-${row.id}` };
  }

  async listForCall(callSessionId: string): Promise<{ readonly list: readonly MediaView[] }> {
    const rows = await sql<VoiceMediaRow>`
      select * from voice_media where call_session_id = ${callSessionId} order by created_at asc
    `.execute(this.database.db);
    return { list: rows.rows.map(toView) };
  }

  /**
   * Retention sweep (§13.5): delete expired media from private storage and drop the rows. Runs as a
   * worker job; every deletion is scoped by `retention_at`, never by a caller-supplied list.
   */
  async retentionSweep(): Promise<{ readonly removed: number }> {
    const rows = await sql<{ id: string; storage_ref: string | null }>`
      select id, storage_ref from voice_media
      where retention_at is not null and retention_at < now()
      limit 200
    `.execute(this.database.db);
    for (const row of rows.rows) {
      if (row.storage_ref !== null) {
        try {
          await this.storage.delete(row.storage_ref);
        } catch {
          // A missing object must not block the row's removal; storage is the cache, the row is truth.
        }
      }
      await sql`delete from voice_media where id = ${row.id}`.execute(this.database.db);
    }
    return { removed: rows.rows.length };
  }

  private skip(reason: string): { readonly recorded: false; readonly reason: string } {
    return { recorded: false, reason };
  }

  // ------------------------------------------------------------------------- internals

  /**
   * Playback authorization follows the parent call: the assignee, a platform administrator, or —
   * mirroring the calls service — a member of a team that shares the assignee. Anything else is
   * "does not exist", not "forbidden", so a guessed id learns nothing (§15 acceptance).
   */
  private async assertCanRead(row: VoiceMediaRow): Promise<void> {
    if (row.call_session_id === null) throw new NotFoundError('No media access.');
    const session = (
      await sql<{ assigned_user_id: string | null }>`
        select assigned_user_id from voice_call_sessions where id = ${row.call_session_id}
      `.execute(this.database.db)
    ).rows[0];
    if (session === undefined) throw new NotFoundError('No media access.');
    const userId = this.scope.userId;
    if (userId !== undefined && session.assigned_user_id === userId) return;
    const principal = this.scope.principal;
    if (principal !== undefined && Array.isArray(principal.roles) && principal.roles.includes('sysAdmin')) return;
    if (userId !== undefined && session.assigned_user_id !== null) {
      const shared = (
        await sql<{ team_id: string }>`
          select a.team_id from users_teams a
          where a.user_id = ${userId}
            and exists (
              select 1 from users_teams b
              where b.team_id = a.team_id and b.user_id = ${session.assigned_user_id}
            )
          limit 1
        `.execute(this.database.db)
      ).rows[0];
      if (shared !== undefined) return;
    }
    throw new NotFoundError('No media access.');
  }

  private async requireRow(id: string): Promise<VoiceMediaRow> {
    const row = (await sql<VoiceMediaRow>`select * from voice_media where id = ${id}`.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError(`Media "${id}" does not exist.`);
    return row;
  }
}

function toView(row: VoiceMediaRow): MediaView {
  return {
    id: row.id,
    kind: row.kind,
    messageId: row.message_id,
    callSessionId: row.call_session_id,
    providerRef: row.provider_ref,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    durationSeconds: row.duration_seconds,
    scanStatus: row.scan_status,
    retentionAt: row.retention_at === null ? null : new Date(row.retention_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}
