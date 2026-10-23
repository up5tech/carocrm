import { type ApprovalPolicyReason,evaluateApprovalPolicy } from './esignature-approval-policy.js';
import type { ESignatureSettings } from './esignature-settings.service.js';
import {
  approvalStillApplies,
  type OutgoingSnapshotData,
  outgoingSnapshotDigest,
  snapshotDigest,
} from './esignature-snapshot.js';
import { evaluateMappingUsage } from './esignature-template.service.js';
import type { SignatureDocumentSnapshot } from './signature-document-snapshot.repository.js';
import type { SignatureRecipient } from './signature-recipient.repository.js';
import type { SignatureRequest } from './signature-request.repository.js';
import type { SignatureTemplateMapping } from './signature-template-mapping.repository.js';

/**
 * Phase 19-ES.8 — the send preview, as a pure function
 * (`PLAN_Phase_19_ESignature.md` §4.3, §4.4, §11.2, §13.3 step 6, §18 `19-ES.8`).
 *
 * The preview is the **whole** of what a send would carry: the documents as snapshotted (with the hash of
 * each), the recipients as submitted, the routing, the message, the provider account and the policy in
 * force. It is built here, without a database write and without a provider call, so the same function
 * answers two questions: "what would be sent?" on the review screen, and "may this be prepared?" when the
 * sender confirms.
 *
 * Four refusals make up the "blocked, not warned" part of the plan:
 *
 *  - **A request with no document, or no signer**, has nothing to send. A carbon copy is not a signer.
 *  - **Two signers with the same address** are ambiguous: the provider would address one human twice,
 *    and which one signs is not decidable from the request.
 *  - **A bound template mapping** must belong to the request's connection, be active, and every role it
 *    declares must be filled by a recipient; every required tab must resolve to a non-empty CRM value
 *    from the linked source record.
 *  - **A request whose expiry is already past** cannot be sent as it stands.
 *
 * What it deliberately does *not* do: it never contacts the provider, never allocates an envelope id and
 * never moves the request. Preparing is a local act; the envelope is ES.9's.
 */

export interface PreviewProblem {
  readonly code:
    | 'no_documents'
    | 'too_many_documents'
    | 'no_signer'
    | 'duplicate_signer_email'
    | 'expiry_in_past'
    | 'connection_missing'
    | 'connection_not_connected'
    | 'mapping_missing'
    | 'mapping_inactive'
    | 'mapping_connection_mismatch'
    | 'missing_role'
    | 'missing_tab_value'
    | 'embedded_signing_disabled'
    | 'source_values_unavailable';
  readonly message: string;
  readonly where: string;
}

export interface SignaturePreview {
  readonly requestId: string;
  readonly requestVersion: number;
  readonly requestStatus: string;
  /** The exact payload a preparation would record; `null` when there is no account context to record. */
  readonly data: OutgoingSnapshotData | null;
  readonly digest: string | null;
  readonly capturedAt: string;
  readonly problems: readonly PreviewProblem[];
  /** True when nothing is missing and a digest exists — the only state `prepare` accepts. */
  readonly ready: boolean;
  /** The approval the *policy* requires, which may be stricter than the draft's own flag. */
  readonly approvalRequired: boolean;
  /** Every policy reason that requires an approval, in the order the policy declares them. */
  readonly approvalReasons: readonly ApprovalPolicyReason[];
  /** Whether the stored approval was given for exactly these bytes. */
  readonly approvedForThisDigest: boolean;
  /** The digest of a preparation already stored on the request, if any. */
  readonly storedDigest: string | null;
  /** True when a stored preparation exists and no longer describes this draft. */
  readonly staleStoredPreview: boolean;
}

export interface PreviewInputs {
  readonly request: SignatureRequest;
  readonly documents: readonly SignatureDocumentSnapshot[];
  readonly recipients: readonly SignatureRecipient[];
  readonly settings: ESignatureSettings;
  /** The connection the request would send through, when it has one. */
  readonly connection: { readonly environment: string; readonly accountId: string | null; readonly status: string } | null;
  readonly mapping: SignatureTemplateMapping | null;
  /** The linked source record's attributes, when it exists and the caller could read it. */
  readonly sourceValues: Readonly<Record<string, unknown>> | null;
  readonly capturedAt?: string | undefined;
}

export function buildSignaturePreview(input: PreviewInputs): SignaturePreview {
  const { request, settings, connection, mapping } = input;
  const documents = [...input.documents].sort((left, right) => left.documentOrder - right.documentOrder);
  const recipients = [...input.recipients].sort((left, right) => left.routingOrder - right.routingOrder || left.name.localeCompare(right.name));
  const signers = recipients.filter((recipient) => recipient.recipientType === 'signer');
  const problems: PreviewProblem[] = [];

  // A template envelope carries the template's own documents, so a mapped request does not need a local
  // one; a document request does (plan §6.7, §4.5).
  const usesTemplate = request.templateMappingId !== null;
  if (documents.length === 0 && !usesTemplate) {
    problems.push({ code: 'no_documents', message: 'The request has no document to sign.', where: 'documents' });
  }
  if (documents.length > settings.documents.maxDocumentsPerRequest) {
    problems.push({
      code: 'too_many_documents',
      message: `The request holds ${String(documents.length)} documents; this installation permits ${String(settings.documents.maxDocumentsPerRequest)}.`,
      where: 'documents',
    });
  }
  if (signers.length === 0) {
    problems.push({ code: 'no_signer', message: 'The request has no signer: a carbon copy is not a signer.', where: 'recipients' });
  }
  const seen = new Map<string, string>();
  for (const signer of signers) {
    const email = signer.email.trim().toLowerCase();
    const first = seen.get(email);
    if (first !== undefined) {
      problems.push({
        code: 'duplicate_signer_email',
        message: `"${signer.name}" and "${first}" are both signers with the address ${email}; which one signs is ambiguous.`,
        where: 'recipients',
      });
    } else {
      seen.set(email, signer.name);
    }
  }
  if (request.expiresAt !== null && Date.parse(request.expiresAt) <= Date.now()) {
    problems.push({ code: 'expiry_in_past', message: 'The expiry date has already passed.', where: 'expiresAt' });
  }
  if (settings.features.embeddedSigning !== true && recipients.some((recipient) => recipient.authenticationMethod === 'embedded')) {
    problems.push({
      code: 'embedded_signing_disabled',
      message: 'A recipient signs inside the CRM, but embedded signing is switched off; the provider would never invite them.',
      where: 'recipients',
    });
  }
  if (connection === null) {
    problems.push({ code: 'connection_missing', message: 'The request does not name a provider connection.', where: 'connectionId' });
  } else if (connection.status !== 'connected') {
    problems.push({
      code: 'connection_not_connected',
      message: `The connection is "${connection.status}", so it cannot carry a signature request.`,
      where: 'connectionId',
    });
  }

  if (request.templateMappingId !== null) {
    if (mapping === null) {
      problems.push({ code: 'mapping_missing', message: 'The template mapping this draft names no longer exists.', where: 'templateMappingId' });
    } else if (!mapping.isActive) {
      problems.push({ code: 'mapping_inactive', message: `The template mapping "${mapping.name}" is switched off.`, where: 'templateMappingId' });
    } else if (mapping.connectionId !== request.connectionId) {
      problems.push({
        code: 'mapping_connection_mismatch',
        message: 'The template mapping belongs to a different provider connection than this request.',
        where: 'templateMappingId',
      });
    } else if (input.sourceValues === null && mapping.fieldMappings.some((field) => field.required)) {
      problems.push({
        code: 'source_values_unavailable',
        message: 'The mapping needs values from the linked record, but that record does not exist or is not readable.',
        where: 'sourceRecordId',
      });
    } else {
      const usage = evaluateMappingUsage(mapping, {
        providedRoles: recipients.map((recipient) => recipient.roleName).filter((role): role is string => role !== null),
        values: input.sourceValues ?? {},
      });
      for (const role of usage.missingRoles) {
        problems.push({ code: 'missing_role', message: `The template role "${role}" is filled by no recipient.`, where: 'roles' });
      }
      for (const field of usage.missingValues) {
        problems.push({
          code: 'missing_tab_value',
          message: `The tab "${field.tabName}" is required but the source record has no "${field.crmField}".`,
          where: 'fields',
        });
      }
    }
  }

  const approvalPolicy = evaluateApprovalPolicy({
    settings,
    sourceEntityType: request.sourceEntityType,
    sourceValues: input.sourceValues,
    explicitRequired: request.approvalRequired,
  });
  const approvalRequired = approvalPolicy.required;
  const approvalBasisDigest = approvalRequired ? snapshotDigest(approvalPolicy.basis) : null;

  const data: OutgoingSnapshotData | null =
    connection === null
      ? null
      : {
          providerKey: request.providerKey,
          connectionId: request.connectionId ?? '',
          environment: connection.environment,
          accountId: connection.accountId,
          templateId: mapping?.providerTemplateId ?? null,
          subject: request.subject,
          message: request.message,
          emailBlurb: request.emailBlurb,
          expiresAt: request.expiresAt,
          documents: documents.map((document) => ({
            documentSnapshotId: document.id,
            displayName: document.displayName,
            mimeType: document.mimeType,
            byteSize: document.byteSize,
            contentHashSha256: document.contentHashSha256,
            documentOrder: document.documentOrder,
            sourceAttachmentId: document.sourceAttachmentId,
          })),
          recipients: recipients.map((recipient) => ({
            recipientId: recipient.id,
            name: recipient.name,
            email: recipient.email,
            recipientType: recipient.recipientType,
            routingOrder: recipient.routingOrder,
            roleName: recipient.roleName,
            authenticationMethod: recipient.authenticationMethod,
          })),
          policy: {
            approvalRequired,
            // A digest, not the values: a change to the reviewed source terms invalidates the stored
            // approval without copying business data into a snapshot every request reader can see.
            ...(approvalBasisDigest === null ? {} : { approvalBasisDigest }),
            sourceEntityType: request.sourceEntityType,
            documents: {
              maxDocumentsPerRequest: settings.documents.maxDocumentsPerRequest,
              maxDocumentBytes: settings.documents.maxDocumentBytes,
            },
            signing: {
              defaultExpiryDays: settings.signing.defaultExpiryDays,
              remindersEnabled: settings.signing.remindersEnabled,
            },
          },
          ...(mapping === null
            ? {}
            : {
                templateMappingId: mapping.id,
                templateMappingVersion: mapping.version,
                // The values the provider will put in the template's tabs. They are part of the reviewed
                // payload: a source record edited after the preview must change the digest (ES.9).
                mappedFields: mapping.fieldMappings.flatMap((field) => {
                  const value = input.sourceValues?.[field.crmField];
                  if (value === undefined || value === null) return [];
                  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
                  return text.trim() === '' ? [] : [{ tabLabel: field.tabName, roleName: field.roleName ?? null, value: text.slice(0, 500) }];
                }),
              }),
        };

  const digest = data === null ? null : outgoingSnapshotDigest(data);
  return {
    requestId: request.id,
    requestVersion: request.version,
    requestStatus: request.status,
    data,
    digest,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    problems,
    ready: problems.length === 0 && digest !== null,
    approvalRequired,
    approvalReasons: approvalPolicy.reasons,
    approvedForThisDigest: approvalStillApplies(request.approvedDigest, digest),
    storedDigest: request.outgoingDigest,
    staleStoredPreview: request.outgoingDigest !== null && request.outgoingDigest !== digest,
  };
}
