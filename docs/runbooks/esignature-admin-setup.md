# ESignature — administrator setup and release runbook

> Companion to `docs/runbooks/esignature-operations.md` (incident procedures) and
> `docs/compatibility/esignature.md` (provider surface and limitations).

## 1. Prerequisites

- `ENCRYPTION_KEY` configured (32-byte hex) so provider credentials can be stored encrypted.
- `UPLOAD_MAX_MB` and storage driver configured for document snapshots and derived artifacts.
- Redis + BullMQ available if background jobs are used.
- DocuSign developer/demo account for sandbox validation before production.

## 2. Create and verify a connection

1. Open **Admin → E-Signature → Connections** (or `/esignature`).
2. Create a named connection, select **Demo** or **Production** explicitly, enter the integration
   key (client id) and redirect URI.
3. Complete OAuth through the backend-controlled callback. The CRM resolves the account id and the
   account-specific API base URI from DocuSign `userinfo`.
4. Verify the connection: account id, user, granted scopes, environment, token expiry metadata and
   last successful API call.
5. Store the Connect HMAC secret in the encrypted vault (never in settings or logs).
6. Configure DocuSign Connect to call `POST /api/v1/integrations/esignature/:publicId` with HMAC.

## 3. Configure templates and policy

1. Refresh the template catalog for the connection.
2. Create template-role mappings; validation rejects unknown roles, tabs or fields.
3. Set policy: which CRM roles may send, who may void, document size/count ceilings, retention,
   embedded signing (off by default) and approval policy.
4. Configure the embedded signing return/cancel host allowlist before enabling that feature.

## 4. Promote Demo to Production

Promotion is an explicit administrator action, never automatic:

1. Create a separate Production connection with its own client id, secret and redirect URI.
2. Verify it independently (account id, base URI, scopes, Test Connection).
3. Configure Connect for the production account.
4. Enable the production connection only after the demo smoke test in
   `esignature-es22-completion-report.md` §3 is recorded with date and outcome.
5. Keep production disabled until the checklist above is complete.

## 5. Rollback / disable procedure

1. Deactivate the connection (`is_active = false`) or move it to `reauthorization_required`. The
   gate refuses every provider operation; existing requests and signed artifacts remain readable.
2. Disable feature flags in the `ESignature` settings row if a broader shutdown is needed.
3. Never delete request history or signed artifacts during an incident.
4. Re-enable only after the cause is resolved and Test Connection succeeds.

## 6. Credential rotation

1. Store the new secret in the vault (rotation creates a new encrypted row; old rows are removed).
2. Re-authorize the connection if the grant or scopes changed.
3. Confirm Test Connection and a webhook delivery before declaring recovery.
4. Remove any stale secret rows; never paste values into tickets or documentation.

## 7. Release checklist

- [ ] `ENCRYPTION_KEY` configured.
- [ ] Demo connection verified end to end (OAuth, template lookup, send, Connect event, artifact).
- [ ] Production connection created but disabled.
- [ ] Connect HMAC verified against a captured demo delivery.
- [ ] Template mappings validated with synthetic documents.
- [ ] Approval policy reviewed by stakeholders.
- [ ] Retention policy agreed with legal/compliance.
- [ ] Runbook and compatibility document reviewed.
- [ ] No secrets in logs, responses, frontend bundles or documentation.
