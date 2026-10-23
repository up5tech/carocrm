# Phase 19-ES.7 — Template Catalog and Field/Role Mapping

> `PLAN_Phase_19_ESignature.md` §6.7, §4.4, §5.2, §8.2, §13.1, §18 `Phase 19-ES.7`.
> Acceptance: an administrator can refresh the template catalog and configure a mapping; mapping
> validation rejects unknown or unauthorized field references; templates and ids stay associated with
> the correct provider account.
>
> Prerequisites read: `esignature-es2-completion-report.md` (the mapping table and its shape checks),
> `esignature-es3-completion-report.md` (the adapter contract and its future operations),
> `esignature-es4-completion-report.md` (the gate and `contextFor`), `esignature-es6-completion-report.md`
> (the request surface this configuration will feed).

ES.7 adds the second half of the provider surface: the account's **template catalog**, read-only, and
the **mapping** that says which CRM recipient fills each template role and which CRM attribute may reach
each tab. The send path (ES.9/ES.10) will build an envelope from one of these mappings, so a mapping that
names a role the template does not have — or a field the source entity cannot supply — is refused the
moment it is saved, not when a contract is on the line.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `providers/signature-provider.port.ts` | `listTemplates` and `templateDetails` move from the *future* list into the contract, with `ProviderTemplateSummary`, `ProviderTemplateRole`, `ProviderTemplateField` and `ProviderTemplateDetail`. `BASE_SIGNATURE_PROVIDER_CAPABILITIES` now commits to both. |
| `providers/fake-signature-provider.adapter.ts` | `FAKE_TEMPLATES` (two deterministic templates) and both reads, with a `NOT_FOUND` provider failure for an unknown id — the fixture every test below maps against. |
| `providers/docusign/docusign-adapter.ts` | The live reads: `GET …/templates?count=100&order_by=name` and `GET …/templates/{id}`, roles from `recipients.signers` / `carbonCopies`, tabs from `documents[].tabs.<kind>Tabs` with `recipientId` resolved to a role name. `DOCUSIGN_ES4_CAPABILITIES` flips the two template flags to true; nothing writes a provider template. |
| `esignature-template.service.ts` | `refresh`, `detail`, `list`, `get`, `create`, `update`, `setActive`, `checkUsage`, and the pure `validateMappingDefinition` with `MappingMetadataLookup`. |
| `esignature-template.controller.ts` | `POST catalog/refresh`, `GET catalog/:connectionId/:templateId`, `GET/POST mappings`, `GET/PATCH mappings/:id`, `POST mappings/:id/active`. |
| `dto/esignature-shapes.ts` | The catalog, mapping-create, mapping-update and active shapes, all strict. |
| `esignature-domain.ts` | `templateMapping.changed` joins the audit vocabulary. |
| `esignature-module.ts` | `templates` leaves `PENDING_FEATURES`; `19-ES.7` joins `IMPLEMENTED_PHASES`. |
| `pages/esignature/ESignatureTemplatesPanel.tsx` (+ `ESignaturePage.tsx`, `api/client.ts`, `api/types.ts`, `i18n/{en,vi}/esignature.json`) | The catalog table, the mapping list with its active switch, and an editor whose role and tab rows are **generated from the live template**. |

**No migration.** `signature_template_mappings` (ES.2) already carries every column a mapping needs,
including the two unique indexes that make "one workflow mapping per template per connection" a database
rule.

---

## 2. How each acceptance criterion is held

**An administrator can refresh the catalog and configure a mapping.** `POST catalog/refresh` reads the
account's templates through the bound adapter and reports how the stored mappings line up with them;
`GET catalog/:connectionId/:templateId` returns the roles and tabs; `POST mappings` validates and
stores. The live check walked it in the SPA: choose the connection → *Refresh catalog* → two templates
with their visibility → *Map this template* → the editor generated `Signer 1`, `Signer 2`, `CC 1` and the
data tabs `Full Name`, `Company` → fill → save → the mapping row appears with the provider template name
snapshotted, and the template's button becomes *Edit mapping*.

**Mapping validation rejects unknown or unauthorized field references.** Six named refusals, each
asserted with its code: `unknown_role`, `missing_role`, `unknown_tab`, `missing_required_tab`,
`unknown_field`, `field_type_not_mappable`, plus `unknown_source_entity` and `duplicate_role`. Two of them
are the "unauthorized" half of the sentence: a field that does not exist on the source entity, and a
field whose metadata type a signature tab cannot carry (`assignedUserId` is a `link`, so it is refused
rather than stringified). A signer-filled tab (`signHere`, `initialHere`, …) is deliberately **not**
required to be mapped — it is where the signer signs, not a CRM value.

**Templates and ids stay with the account.** Every catalog read is scoped to one connection, the mapping
row carries its `connection_id`, the list API refuses to answer without one, a mapping names the
provider template it was built from (snapshot), and a template the account does not have is refused with
`TEMPLATE_NOT_FOUND` — the fake adapter's `NOT_FOUND`, translated by the service into a validation
failure that names the connection. The suite creates mappings in two connections for the same template id
and asserts neither list nor the "mapping for this template" lookup crosses over.

---

## 3. Decisions taken here

- **The catalog is read live, not cached in a table.** The plan's data model has one mapping table and no
  template table; adding one would duplicate the provider's data and go stale silently. `refresh`
  therefore reads the provider and returns the latest, and the mapping's `provider_template_name` is the
  only copy the module keeps — as a snapshot of what the mapping was reviewed against.
- **A vanished template is reported, not deleted.** `refresh` marks a mapping `presentInCatalog: false`;
  the row stays so an administrator can see why a request can no longer be prepared from it. Deactivating
  is the retirement path, and nothing in the API deletes a mapping.
- **Validation needs the live template, so saving one needs a live connection.** That is deliberate: a
  mapping validated against a cached copy would be validated against a template that may since have
  changed. A connection that is not usable therefore refuses the whole surface through the ES.1 gate —
  and the test proves the gate's own 409 rather than this service's opinion.
- **Two literal route prefixes (`catalog/`, `mappings/`).** With one `:connectionId/:templateId` shape,
  `GET templates/mappings/:id` would also match a template detail; mixing a mapping list with a template
  detail is how configuration crosses accounts. The literal prefixes make the router's answer
  unambiguous.
- **`templateMappingManage` is its own capability.** The person who maps a contract's fields is not
  necessarily the person who holds the provider credential (ES.1's matrix already separated them); the
  service asserts only that right, and a test with a role holding just it succeeds while a plain user is
  refused.
- **Source field references are validated on every named entity.** If a mapping serves `Account` and
  `Quote`, the field must exist on both — a mapping that works for one source and breaks for another is
  worse than a refused one.
- **`checkUsage` is the hand-off to ES.8/ES.9.** It answers "what is missing for this concrete request"
  (unfilled template roles, required tabs whose mapped value is blank). It is a service method with no
  route: the preview screen (ES.8) is where a user should see it.

---

## 4. Verification

| Suite | Covers |
| --- | --- |
| `apps/api/test/esignature-docusign.test.ts` (+4) | catalog parsing from the stored base URI, id-less entries skipped; roles from signers and CCs, tabs resolved through `recipientId`, unknown tab collections ignored; a dangling recipient id leaves `roleName: null`; 404 → `NOT_FOUND`, blank id → `permanent_validation`. |
| `apps/api/test/esignature-templates.test.ts` (19) | refresh + detail through the routes against two connected accounts; create/list/update/active; every validation refusal; the per-template uniqueness handled by retiring the prior fixture; cross-connection isolation incl. the same template id in both accounts; a template the account lacks; an orphan mapping reported by refresh; `checkUsage` for a complete and an incomplete request; the capability split; the feature switch; the gate's no-usable-connection refusal. |

The module's own suites are now **211 green** (ES.1 20, ES.2 53, ES.3 31, ES.4 41, ES.5 25, ES.6 18,
ES.7 23). `pnpm typecheck`, `pnpm -r build` and `pnpm lint` are green; the full `pnpm test` run is
**2 478 passed / 8 failed in 5 files**, all eight in the pre-existing set named in §6.

**Live check** (scratch API `:3043` from the repo root, Vite on `:5143`, admin session): a connected demo
account; the catalog refresh returned `Fake Service Agreement` (account shared) and `Fake Mutual NDA`
(private); the editor generated the template's three roles and two data tabs — `Sign Here` was correctly
absent, and `Full Name` arrived checked because the tab is required; saving with `Signer 1 → emailAddress`
and `Full Name → name` produced the mapping row named after the provider template, and the panel's
template button switched to *Edit mapping*. Afterwards the shared dev database holds zero rows in every
ESignature table and no `ESignature` settings row.

---

## 5. What later phases take from here

- **ES.8** calls `checkUsage` for the preview: missing roles and required values become the warnings the
  sender must resolve before confirming.
- **ES.9** builds `prepareEnvelopeInput` from a mapping: `templateId`, the role names, and the tab values
  resolved from the source record through the mapped fields.
- **ES.11/ES.15** are unaffected: templates are read-only and no request state depends on them.
- A future template *management* requirement (creating or editing a provider template) would need its own
  adapter methods and a security review — plan §6.7 says so, and nothing here opens that door.

## 6. Known limits and the pre-existing baseline

- The catalog read takes the provider's first page (100 templates) and names no pagination: an account
  with more needs a paging pass, which the plan's admin screen does not yet require.
- `order` on the catalog request asks DocuSign to sort by name; a provider that ignores it simply returns
  its own order, and nothing depends on the ordering.
- Tabs are read from the tab collections the adapter knows (`textTabs`, `signHereTabs`, …). A tab kind a
  future DocuSign release adds would be ignored rather than mapped — the conservative direction.
- The mapping editor generates rows from the live template but does not re-validate on every keystroke;
  the server's problems are shown after a save attempt.
- Pre-existing full-suite failures, unchanged: `docs-content` + `packages/docs/corpus`
  (`/EmailTemplate` `unknownAppRoute`, commit `5ce375e`) and the `service-desk*` suites (shared dev-DB
  state and a time-of-day-dependent SLA assertion).
