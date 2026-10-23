import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { ZodTypeAny } from 'zod';

import {
  RequestCreateSchema,
  RequestDocumentAttachSchema,
  RequestDocumentReplaceSchema,
  RequestEmbeddedViewSchema,
  RequestEnvelopeSchema,
  RequestEventsQuerySchema,
  RequestListQuerySchema,
  RequestPrepareSchema,
  RequestRecipientsSchema,
  RequestSendSchema,
  RequestUpdateSchema,
} from './dto/esignature-shapes.js';
import { REQUEST_STATUSES, type SignatureRequestStatus } from './esignature-domain.js';
import { ESignatureRequestService } from './esignature-request.service.js';

/**
 * Phase 19-ES.6 — the signature request draft API
 * (`PLAN_Phase_19_ESignature.md` §8.2, §13.2, §18 `19-ES.6`).
 *
 * The routes the wizard and the list screen call. Every one of them delegates to a service that checks
 * the capability *and* the record scope before it answers; the controller only parses shapes, so a
 * malformed body is a 400 and an unauthorized one is a 403 that says nothing about which records exist.
 *
 * There is deliberately no `DELETE`: a request is evidence. A draft is removed through the module's own
 * soft-delete path when ES.6's later slice exposes it, not through a generic entity route — and there is
 * no generic route to reach: signature requests live in their own tables, not in `entity_records`.
 */
@ApiTags('esignature')
@Controller('api/v1/ESignature/requests')
export class ESignatureRequestController {
  constructor(@Inject(ESignatureRequestService) private readonly requests: ESignatureRequestService) {}

  /**
   * The list (plan §13.2).
   *
   * Filters are validated, not passed through: an unknown status is a bad query rather than an empty
   * page, and `limit` is clamped by the repository so a caller cannot ask for the whole table.
   */
  @Get()
  async list(@Query() query: unknown) {
    const parsed = this.parse(RequestListQuerySchema, query);
    return this.requests.list({
      statuses: this.statuses(parsed.status),
      ...(parsed.sourceEntityType === undefined ? {} : { sourceEntityType: parsed.sourceEntityType }),
      ...(parsed.sourceRecordId === undefined ? {} : { sourceRecordId: parsed.sourceRecordId }),
      ...(parsed.connectionId === undefined ? {} : { connectionId: parsed.connectionId }),
      ...(parsed.assignedUserId === undefined ? {} : { assignedUserId: parsed.assignedUserId }),
      ...(parsed.needsAttention === undefined ? {} : { needsAttention: parsed.needsAttention === 'true' }),
      limit: parsed.limit,
      offset: parsed.offset,
    });
  }

  @HttpCode(201)
  @Post()
  async create(@Body() body: unknown) {
    return this.requests.create(this.parse(RequestCreateSchema, body));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.requests.get(this.id(id));
  }

  /**
   * Edit a draft.
   *
   * `version` travels in the body rather than an `If-Match` header because the SPA already renders the
   * version and a body validator refuses a missing one outright; a stale version is a 409 from the
   * repository's compare-and-set.
   */
  @HttpCode(200)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const { version, ...patch } = this.parse(RequestUpdateSchema, body);
    return this.requests.update(this.id(id), { version, patch });
  }

  /**
   * The send preview (plan §13.3 step 6): exactly what a send would carry, and everything that would
   * block it. A read: no version bump, no snapshot stored, no provider contact.
   */
  @Get(':id/preview')
  async preview(@Param('id') id: string) {
    return this.requests.preview(this.id(id));
  }

  /**
   * Record the immutable preview and move the request on.
   *
   * The body carries `confirm: true` — the sender's deliberate act — and `version`, so a stale screen
   * cannot prepare a draft somebody else has since edited. No provider is contacted here; ES.9 creates
   * the envelope, and only ES.10 sends it.
   */
  @HttpCode(200)
  @Post(':id/prepare')
  async prepare(@Param('id') id: string, @Body() body: unknown) {
    return this.requests.prepare(this.id(id), this.parse(RequestPrepareSchema, body));
  }

  /**
   * Create the provider-side draft envelope from the prepared snapshot (ES.9).
   *
   * A draft: no invitation, no email, and the request stays `ready_to_send`. A retry returns the
   * envelope already recorded; an edit after preparation is refused until the preview is prepared again.
   */
  @HttpCode(200)
  @Post(':id/envelope')
  async prepareEnvelope(@Param('id') id: string, @Body() body: unknown) {
    return this.requests.prepareEnvelopeAtProvider(this.id(id), this.parse(RequestEnvelopeSchema, body));
  }

  /** Delete the provider draft and forget it, while nothing has been sent. */
  @HttpCode(200)
  @Post(':id/envelope/abandon')
  async abandonEnvelope(@Param('id') id: string) {
    return this.requests.abandonProviderEnvelope(this.id(id));
  }

  /**
   * Send the prepared draft (ES.10). The one irreversible act: `confirm: true`, a current version, a
   * matching prepared preview, the approval the policy requires, and an existing provider envelope.
   *
   * Exactly one of three answers: the request is `sent`; a definite refusal left it in `provider_error`
   * (recoverable); or the outcome is unknown and it is held in `send_unknown` for reconciliation — never
   * retried here.
   */
  @HttpCode(200)
  @Post(':id/send')
  async send(@Param('id') id: string, @Body() body: unknown) {
    return this.requests.send(this.id(id), this.parse(RequestSendSchema, body));
  }

  /** Return a request whose send was definitely refused to a state a deliberate retry can use. */
  @HttpCode(200)
  @Post(':id/send/recover')
  async recoverSend(@Param('id') id: string) {
    return this.requests.recoverSend(this.id(id));
  }

  /** Ask the provider what happened to an ambiguous send; the only way out of `send_unknown`. */
  @HttpCode(200)
  @Post(':id/reconcile')
  async reconcileSend(@Param('id') id: string) {
    return this.requests.reconcileSend(this.id(id));
  }

  /** The activity timeline: normalized provider events and lifecycle audit entries (ES.13). */
  @Get(':id/events')
  async events(@Param('id') id: string, @Query() query: unknown) {
    const parsed = this.parse(RequestEventsQuerySchema, query);
    return { list: await this.requests.timeline(this.id(id), parsed.limit) };
  }

  /**
   * One recipient's short-lived embedded signing URL (ES.14).
   *
   * The caller must be the named signer and the return host must be allowlisted. The URL is returned
   * once and never stored; opening it does not complete anything.
   */
  @HttpCode(200)
  @Post(':id/embedded-view')
  async embeddedView(@Param('id') id: string, @Body() body: unknown) {
    return this.requests.createEmbeddedView(this.id(id), this.parse(RequestEmbeddedViewSchema, body));
  }

  /** Retrieve the signed documents and the certificate of completion (ES.15). Idempotent. */
  @HttpCode(200)
  @Post(':id/artifacts/retrieve')
  async retrieveArtifacts(@Param('id') id: string) {
    return this.requests.retrieveCompletedArtifacts(this.id(id));
  }

  @Get(':id/recipients')
  async recipients(@Param('id') id: string) {
    return this.requests.listRecipients(this.id(id));
  }

  /** The whole set is replaced, because two signers in one routing slot is not a mergeable state. */
  @HttpCode(200)
  @Put(':id/recipients')
  async replaceRecipients(@Param('id') id: string, @Body() body: unknown) {
    const { recipients } = this.parse(RequestRecipientsSchema, body);
    return this.requests.replaceRecipients(this.id(id), recipients);
  }

  @Get(':id/documents')
  async documents(@Param('id') id: string) {
    return this.requests.listDocuments(this.id(id));
  }

  /** Attach an existing, readable CRM attachment. The snapshot copy happens in ES.5's service. */
  @HttpCode(201)
  @Post(':id/documents')
  async attachDocument(@Param('id') id: string, @Body() body: unknown) {
    return this.requests.attachDocument(this.id(id), this.parse(RequestDocumentAttachSchema, body));
  }

  /** Replace the file in one numbered slot. The previous snapshot is retired, not rewritten. */
  @HttpCode(200)
  @Put(':id/documents/order/:order')
  async replaceDocument(@Param('id') id: string, @Param('order') order: string, @Body() body: unknown) {
    const { attachmentId } = this.parse(RequestDocumentReplaceSchema, body);
    return this.requests.replaceDocument(this.id(id), this.order(order), attachmentId);
  }

  @HttpCode(200)
  @Delete(':id/documents/:documentId')
  async detachDocument(@Param('id') id: string, @Param('documentId') documentId: string) {
    return this.requests.detachDocument(this.id(id), documentId.trim());
  }

  /**
   * The exact snapshotted bytes, for a caller who may read the request.
   *
   * Possession of a document id is not access: the service checks the request's capability and record
   * scope, then the snapshot's ownership, and only then reads the object — which is re-hashed against
   * the recorded digest before it is returned (plan §4.5).
   */
  @Get(':id/documents/:documentId/content')
  async download(@Param('id') id: string, @Param('documentId') documentId: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const { document, bytes } = await this.requests.openDocument(this.id(id), documentId.trim());
    reply.header('content-type', document.mimeType);
    reply.header('content-disposition', `attachment; filename="${escapeFilename(document.displayName)}"`);
    reply.header('content-length', String(bytes.byteLength));
    reply.header('x-checksum-sha256', document.contentHashSha256);
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    return bytes;
  }

  // ---------------------------------------------------------------------------
  // parsing
  // ---------------------------------------------------------------------------

  private parse<T extends ZodTypeAny>(schema: T, value: unknown): T['_output'] {
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) {
      throw new InvalidQueryError('Invalid ESignature request.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    return parsed.data;
  }

  /** `status=draft,sent` → the enum values, refusing a name the module does not know. */
  private statuses(value: string | undefined): readonly SignatureRequestStatus[] | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    const wanted = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const unknown = wanted.filter((entry) => !(REQUEST_STATUSES as readonly string[]).includes(entry));
    if (unknown.length > 0) {
      throw new InvalidQueryError('Unknown signature request status.', { statuses: unknown });
    }
    return wanted as readonly SignatureRequestStatus[];
  }

  private id(value: string): string {
    const id = value.trim();
    if (id === '' || id.length > 64) throw new InvalidQueryError('Invalid ESignature request.', { issues: [{ path: 'id', message: 'A request identifier is at most 64 characters.' }] });
    return id;
  }

  private order(value: string): number {
    const order = Number(value);
    if (!Number.isInteger(order) || order < 1 || order > 100) {
      throw new InvalidQueryError('Invalid document order.', { issues: [{ path: 'order', message: 'A document order is an integer from 1 to 100.' }] });
    }
    return order;
  }
}

/** A quoted filename a header can carry: no quotes, backslashes or control characters. */
function escapeFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '_');
}
