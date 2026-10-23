# Phase 19-ES.14 — Embedded Signing

> `PLAN_Phase_19_ESignature.md` §4.6, §12.7, §18 `Phase 19-ES.14`.
> Acceptance: an authorized recipient can start embedded signing in the demo environment; unrelated
> users cannot request a view for another recipient; completing the browser view does not itself mark
> the local request completed — the provider event/status does.
>
> Prerequisites read: `esignature-es8-completion-report.md` (the snapshot and its recipient policy),
> `esignature-es12-completion-report.md` (events are the only completion evidence).

ES.14 adds the one route that hands a signer a bearer credential. The design treats that credential as
radioactive: it is generated only for the named person, only for an allowlisted return host, and it is
never stored, audited or logged.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `providers/signature-provider.port.ts` | `recipientView` is a first-class operation; `PrepareEnvelopeRecipient.clientUserId` carries the embedded identity set at preparation. |
| `providers/docusign/docusign-adapter.ts` | `POST /envelopes/{id}/views/recipient` with `recipientId`, `clientUserId`, `returnUrl`; a URL is required in the answer, and the adapter reports a conservative five-minute lifetime. |
| `providers/fake-signature-provider.adapter.ts` | A deterministic fake URL for an open envelope and an unfinished recipient; it records only the recipient id and the return host. |
| `esignature-request.service.ts` | `createEmbeddedView` — feature gate, record ACL, recipient match, signer identity, return/cancel allowlist, provider call, audit without the URL. |
| `esignature-preview.ts` | A draft marked `embedded` while the feature is off is blocked before preparation. |
| `esignature-request.service.ts` — preparation | Sets `clientUserId` only for a **signer** whose `authenticationMethod` is `embedded` and only while the feature is on. |
| `pages/esignature/ESignatureRequestsPanel.tsx` | The signing-mode selector in the draft editor and *Sign now* for an outstanding embedded signer. |
| `esignature-request.controller.ts` | `POST /requests/:id/embedded-view` (`{recipientId, returnUrl, cancelUrl?}`). |

**No migration.** The local recipient id is the provider's `clientUserId`; no column was needed.

---

## 2. How each acceptance criterion is held

**Only the matched signer gets a view.** The service loads the request through the record ACL, requires
the feature to be effective and the provider to declare `recipientView`, then requires the named
recipient to be a `signer` marked `embedded`. Finally it compares the signed-in user's `users.email_address`
with the recipient's snapshot email (case-insensitive) and refuses anyone else with
`RECIPIENT_NOT_AUTHORIZED` — an admin is not special here. The recipient row must exist on this request.

**The URL cannot leave the installation by accident.** `returnUrl` and optional `cancelUrl` must parse,
be HTTPS (HTTP is allowed only for loopback), and name a host on `signing.embeddedReturnHosts`; an empty
allowlist refuses every view. The URL is returned once. It is never written to the request, an event, an
audit detail or a log line; the audit records only the recipient id and the expiry.

**Opening the browser completes nothing.** The endpoint only generates a session. The request stays
`sent`/`delivered`; the ES.12 event or an explicit reconciliation is what reports a signature. The UI's
*Refresh from provider* is the post-signing path.

**A draft cannot silently become un-signable.** If a recipient is embedded while the feature is off, the
preview reports `embedded_signing_disabled` and preparation is refused. When the feature is on, only
signers get a `clientUserId`; a carbon copy configured as embedded is still emailed.

---

## 3. Decisions taken here

- **Embedded is a per-recipient draft choice**, stored in the existing `authentication_method` field and
  carried in the reviewed snapshot. The UI exposes it as "Email invitation" / "Embedded in CRM".
- **The feature gate uses `use`, not `send`.** A signer is not a sender; the record ACL and the email
  match are the authorization. ES.1's provisional `send` requirement was corrected here.
- **The provider's URL lifetime is not trusted as a promise.** The adapter reports a conservative
  five-minute expiry a screen may display; the URL is used immediately.
- **The audit redaction is the second line of defence.** Even if a caller passed a URL in a detail object,
  the audit repository drops URL-shaped keys by segment.

---

## 4. Verification

- `apps/api/test/esignature-lifecycle.test.ts` — preparation sets the client user id for an embedded
  signer; the matched user gets a URL; the unrelated user is refused with `RECIPIENT_NOT_AUTHORIZED`; a
  foreign return host is refused and the provider is not called; opening the view leaves the request
  `sent`; a non-embedded recipient is refused with `recipient_not_embedded`; the audit detail contains
  no signing URL.
- `apps/api/test/esignature-docusign.test.ts` — the live adapter's request body (`clientUserId`,
  `recipientId`, `returnUrl`) and the URL requirement.
- Browser pass confirmed the signing-mode selector and *Sign now* render; see ES.16 report §4.

## 5. Still open

- Demo-account verification of the recipient-view response is ES.22.
- A request prepared with an embedded signer still sends the envelope; the signer is not emailed by the
  provider, so the sender must hand over the link from this screen. A future notification is a product
  decision, not assumed here.
- The signing session itself is hosted by DocuSign; the CRM does not re-implement the signing UI.
