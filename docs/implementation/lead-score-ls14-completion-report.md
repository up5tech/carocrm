# Phase 19-LS.14 — Conversion Wizard UI and Converted-To Panel: completion report

`PLAN_Phase_19_LeadScore.md` §7.1–§7.4, §11.4, §13.4-6/7, §16 (`19-LS.14`); audit §11 `LS.14`; contract
`docs/implementation/lead-score-conversion-contract.md` §8, §11.4, §12.2; compatibility
`docs/compatibility/lead-score.md` §3 (Conversion interface), §4.1–§4.3, §8.

**Exit criterion (plan §16):** *a user can complete valid Contact/Account conversion end-to-end with clear
feedback.* The Playwright spec does exactly that through the screen — and, because "clear feedback" is easy to
fake, it asserts the three things that make it true: the review is the **server's preview** (values, gaps,
skips, conflicts, duplicates, confirmations), confirming **re-runs that preview** and re-shows it when the plan
moved, and the result separates **Created** from **Linked** with links that open the records the API actually
made.

## 1. What landed

**The card — `LeadConversionSection`** (in `apps/web/src/components/LeadConversionWizard.tsx`, mounted on the Lead
detail next to the score card). It renders only when `GET /api/v1/LeadScore/action/conversion/affordance?leadId=`
answers; a converted Lead shows "Converted on …" with links to the Contact and the Account, and an unconverted one
shows the button plus the reasons it is off, if any. No client-side role logic: the server's answer decides.

**The wizard — three steps, antd `Steps` in a `Modal`.**

| Step | What it is |
| --- | --- |
| **Targets** | Per type (Account first, then Contact): *do not build* / *create new* / *link existing*, the last with a searchable picker over the 50 most recently modified records the caller may read. The Account row leads because a Contact is linked to it (plan §11.4). |
| **Review** | The preview, rendered: `proposed` with the target's own metadata labels, `required` in danger text, `skipped` with a translated reason per line, `conflicts` as `before → after` with an **opt-in merge checkbox** per field, `notCopied`, the relationship the command will set, the duplicate candidates with their match class and reasons plus the hidden-match count, the duplicate-override box (only when the caller holds `duplicateOverride`), the re-parent box when the preview asks for it, and the `confirmationTypes` as sentences. |
| **Result** | "This Lead is converted", the **Created** and **Linked** ids as links to the records, and the completion time. |

**The two behaviours that make the feedback honest.**

1. **Confirm re-runs the preview.** Ticking a merge re-previews (the fingerprint covers merges); clicking
   Convert takes the preview again with exactly the plan about to be sent. If the fingerprint differs from what is
   on screen, the screen shows the refreshed plan and a note, and waits for a second confirm — nothing is
   converted against a plan nobody saw. A `LEADSCORE_PREVIEW_STALE` from the command takes the same path.
2. **Recovery is the operation key.** The request body — key included — is written to `sessionStorage` *before*
   the call. On a lost response or a reload, the wizard offers **Resume it**, which re-sends that exact body: the
   server replays a committed result, answers "in flight" while it runs, and cannot create a second set of
   records. A deterministic refusal (4xx that is not in-flight) clears the stored body, because replaying that
   key would only replay a `failed_final` row.

**One server addition.** `GET action/conversion/affordance?leadId=` — `{canPreview, canConvert, canOverride,
alreadyConverted, status, convertedAt, convertedContactId, convertedAccountId, operationId, reasons[]}`. It is a
read with no capability gate of its own (module switch and the Lead's record ACL still apply): a button has to be
able to ask and receive "no, because…" rather than an error. It lives on its own endpoint rather than as a block
on the score read because the score read needs `viewScore`, and a converter may hold only the conversion rights —
the contract §12.2 said "the Lead read view", and this is the deviation, recorded in the contract.

**The `Converted To` panel needed nothing.** LS.2's metadata layout already places the six references, and the
spec asserts the panel appears after a conversion. The card adds the links in context; the panel remains the
record's own answer.

## 2. The findings that changed the implementation

**A `has:` locator is re-rooted under its candidate.** The first spec run failed every test at the same click:
`.carocrm-conversion-target` filtered by `has: modal.locator('strong', …)` never matched, because Playwright
queries the `has:` locator *inside* each candidate, and a locator already anchored at the modal can never match
its own descendant. The helper now takes the `page` and builds the inner locator from the page root — the same
shape the existing specs use. This is a test-infrastructure lesson, not a product one, but it is the kind of
thing that makes a green suite meaningless if it is "fixed" by loosening the selector.

**A duplicate warning is two different sentences.** "Possible duplicates" is both a section heading and the
start of the server's refusal message, so a `getByText` without `exact` matched two elements and strict mode
failed. The test asserts the heading exactly and, separately, that the result screen has *not* appeared.

**`:focus-visible` is a heuristic, not a CSS fact.** Programmatic `focus()` after mouse clicks does not match it;
the phone test sends a `Tab` first, which is also what a keyboard user does. Checking `focus()` alone would have
proved nothing about keyboard use.

**The launcher must not close the modal it just succeeded in.** The first wiring closed the wizard from
`onConverted`, so the result step — the whole point of "clear feedback" — flashed and disappeared. The section now
only refreshes its affordance and the record; the wizard closes on **Done**, which is also where the links are.

**`crypto.randomUUID` behind a guard.** The operation key is generated once per plan attempt and kept for retries;
the fallback exists for non-secure contexts, because losing the key would turn a recovery into a second
conversion.

## 3. Verification

- `e2e/lead-conversion.spec.ts` — **6 Playwright tests**, each signing in as an administrator against the running
  app:
  - **create**: Contact + Account from a fresh Lead; the review shows "Will be written" and the company value and
    "Before you confirm"; Convert produces "This Lead is converted" with a `Created` link whose `href` is a real
    `/Contact/…`; Done leaves the card saying "Converted on" and the metadata **`Converted To`** panel visible;
    the API agrees (`status: Converted`, both references set) and exactly **one** Contact carries that e-mail.
  - **link**: an existing Contact + Account; the result stores the two linked ids and the Contact's `accountId`
    becomes the chosen Account.
  - **duplicate**: a Contact with the same e-mail; Convert is refused by the command and the screen shows why;
    ticking "Create anyway" then converts once.
  - **stale**: the review is open, the Lead is edited through the API, Convert refreshes the plan and shows the
    note — nothing is converted, no result appears — and a second Convert completes it.
  - **lost response**: the first `/conversion/convert` request is sent and its response thrown away by the route;
    the wizard offers "Try again with the same operation key"; the retry succeeds and exactly one Contact exists.
  - **phone**: 390 px, no horizontal overflow, a visible focus ring on Review reached by keyboard, and Escape
    closes the dialog.
- `apps/api/test/lead-score-conversion.test.ts` — **+3 affordance tests** (yes for a convertible Lead then
  `alreadyConverted` with the operation and contact ids; a **200 with `cannot_preview`/`cannot_execute`** for a
  caller without the rights, not a 403; the module door and a Lead outside `own` scope answering 404).
- All fourteen LeadScore API files together — **305 passed / 0 failed**. Full `npx vitest run` — **2,941 passed /
  33 failed across 205 files**: zero `lead-score` failures, and the failures are the same seven pre-existing
  shared-state files (`ai-agent-runs`, `service-desk` ×3, `crm-chat` ×3 — one of them recovered a test this run,
  which is what those files do). Worker suite **210 passed / 0 failed**. The **three** LS Playwright specs run
  together — **15 passed in 46 s** (LS.14's 6 + LS.8's 6 + LS.7's 3), which is also the clean-duration baseline the
  LS.8 version-diff flake noted in 19-LS.13 was missing. `npm run typecheck`, `npx eslint` on every touched path,
  and both builds.
- No migration. The wizard stores one `sessionStorage` entry per Lead and nothing else.
- Residue: the spec deletes its Leads, Contacts and Accounts; the conversion operation rows it produces are
  append-only (no delete route) and were swept at the database level by run marker together with the targets the
  conversions created and their `outbox_events` — 10 operation rows, 10 events and 21 target records removed, with
  a final query over the marker returning nothing.

## 4. What this phase does not claim

- **No Opportunity in the wizard.** The preview refuses it until LS.16, and the Targets step only offers Account
  and Contact. The `opportunity_created` confirmation type stays unreachable.
- **No general record search beyond the bounded picker.** "Link existing" lists the 50 most recently modified
  records the caller may read and filters them client-side; there is no server-side search-by-name endpoint for
  this picker yet. A record outside that window can be linked by choosing it from its own list first — noted as a
  limitation, not hidden.
- **No map editor.** The field map is configured through `POST action/settings` (LS.12); the wizard shows its
  effect, not its configuration.
- **No operations screen.** The recovery *API* (`action/conversion/operations`, retry/close) exists; the
  administrator's list is still a contract §11.3 obligation with no screen, and LS.14's plan does not ask for one.
- **No activity/attribution move** (LS.15), no auto-conversion, no bulk conversion, and no correction workflow
  (G9 stands).
- **The card depends on the module being on and the Lead being readable**, by design; a caller with `viewScore`
  but no conversion rights sees the reasons rather than a disabled mystery button, and a caller without
  `viewScore` still sees the Conversion card because its affordance is its own read.
- LS.15–LS.18 are not started.
