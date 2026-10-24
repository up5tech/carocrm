# Phase 19-LS.7 — Lead Detail and List UI: completion report

Delivered 2026-10-25. Scope: `PLAN_Phase_19_LeadScore.md` §11.1, §12, §16 `19-LS.7`; contract in
`docs/implementation/lead-score-audit.md` §5.3–§5.4 and §11; compatibility rows in
`docs/compatibility/lead-score.md` §3, §7 and §9.

**Acceptance, as the plan writes it:** *"the UI uses API data and never bypasses field/record ACL."* LS.5
proved a stored number can be explained and dated, and LS.6 proved it can be produced without anybody asking.
This phase is the surface a salesperson meets, and the criterion is a boundary rather than a feature list:
nothing on the screen is computed, derived or guessed in the browser.

---

## 1. What landed

| File | Responsibility |
| --- | --- |
| `apps/web/src/components/LeadScorePanel.tsx` (new) | The Lead Score card: the stored number, the band, the freshness verdict and its reason, coverage, movement from the previous score, the model version and both timestamps, the rule-by-rule reason list, the paged history in a drawer with each evaluation's own breakdown, and the two actions the server said this caller may take. Renders nothing when the read refuses; mounted only for `Lead` outside the portal. |
| `apps/web/src/pages/EntityDetailPage.tsx` | Mounts the card for `entity === 'Lead' && base !== '/portal'`, next to the other module panels, with `onChanged` reloading the record because a stored score is a write onto this Lead. |
| `apps/web/src/api/client.ts`, `api/types.ts` | `leadScoreRead`, `leadScoreHistory`, `leadScoreRecalculate` and the mirrored view types, including the `actions` answer. |
| `apps/api/src/lead-score/lead-score-explanation.service.ts` | `ScoreReadView.actions` — `{ recalculate, history }`, each `{ allowed, reason }`, computed from `gate.assess()` plus the core `Lead:edit` right. This is what lets the card show a button only where the server would accept it. |
| `database/seed-metadata.ts` | The projection enters the list: `scoreValue` and `scoreBand` are `inList` and `inFilter`, `scoreStatus` filters without being a column, the provenance fields say `inFilter: false` explicitly, and all nine are `inDetail: false` because the card is now their surface (§2.3). |
| `apps/web/src/state/metadata.ts` | `filterEntries` honours an explicit `inFilter: false` and never lets the twelve-field cap drop a field an administrator asked for. |
| `apps/web/src/pages/EntityListPage.tsx` | The filter panel's disclosure (`{n} more filters` / `fewer filters`): the panel showed five controls and silently truncated the rest, which made a new projection filter unreachable on a wide entity. |
| `i18n/{en,vi}/leadscore.json` | `panel.*` (titles, actions, states, history), `band.*` and `panel.trigger.*`; `i18n/{en,vi}/web.json` gains the two filter-disclosure keys. |
| `apps/web/src/styles/carocrm.css` | The headline row (number, band, movement, coverage) that wraps at a phone width, and the rule row's compact rhythm. |
| `apps/api/test/lead-score-explanation.test.ts` (+4), `lead-score-schema.test.ts` (+1), `e2e/lead-score.spec.ts` (new, 3) | The evidence. |

## 2. The three findings that changed the design

1. **A bad i18n key does not lose one label — it loses every label on the instance.** The first version of
   the card keyed band names by their value, so a model's `Sales Ready` produced
   `leadscore.band.Sales Ready`. The platform validates every catalog segment as `[a-z][a-z0-9_]*`, and
   `I18nService` treats a validation failure as a *load* failure: it logged `i18n catalog load failed;
   translations disabled` and every string in the SPA — the navigation, the record header, everything —
   rendered as its key. Nothing in the test suite noticed, because no test asked for a Vietnamese word after
   that point. Fixed by keying bands through a name→segment mapping (`sales_ready`) with a fallback to the
   model's own text, and by a suite that now asserts every key the card uses resolves in **both** locales,
   server-side, so the next space in a key fails a test instead of silently degrading the product.
2. **`t()` on a parent key returns an error string, not a label.** The history drawer's trigger column was
   titled `t('leadscore.panel.trigger')` — the parent of `panel.trigger.<code>` — and i18next rendered
   `key 'leadscore.panel.trigger (vi)' returned an obj…` as a column header. Leaf keys only (`triggerHeader`),
   and the interpolation placeholders are `{name}` not `{{name}}` because this app configures i18next with
   single-brace interpolation to match the server (§41).
3. **Two surfaces showing the same stored number is a defect, not a fallback.** LS.2 had put the nine
   projection fields in a generic `Score` detail panel *because* nothing else could display them, and left a
   note that LS.7 would build the UI that explains them. With the card in place, the raw panel repeated value,
   band, state, model, version, both timestamps, coverage and the previous number, and `scoreReasonCodes`
   rendered as a JSON blob in the trailing "Other" card. The fields are `inDetail: false` now and the `score`
   panel is gone from the Lead layout. This is the stricter surface, not the looser one: the card prints no
   Lead value at all, and it is served through `viewScore` plus the record's own read ACL. `converted` stays
   as LS.2 declared it — the conversion command is 19-LS.13 and nothing else shows those references.

A fourth decision is the one a reviewer will look for: **the affordance is the server's answer.**
`GET action/score/:leadId` now carries `actions.recalculate` / `actions.history`, each with the stable code of
a refusal (`AUTHORIZATION_DENIED`, `LEADSCORE_MODULE_DISABLED`, `LEAD_NOT_EDITABLE`). The card renders exactly
that, so a role that can see a badge but not press the button sees a badge — and the button's absence is
never the authorization, which is still enforced in the command itself.

## 3. What each half guarantees, and where it is asserted

| Guarantee | Where |
| --- | --- |
| No score is computed in the browser | the card's only inputs are `leadScoreRead` / `leadScoreHistory` / `leadScoreRecalculate`; there is no evaluator import in `apps/web`, and the number, band, coverage and reason text all arrive labeled from the server |
| The explanation cannot read past field ACL | e2e: the rule's own input value (`Playwright Industries`) is asserted **absent** from the reason block, which shows rule name, dimension and outcome only |
| A button appears only where the server would accept it | 3 API tests: an administrator gets both doors; a badge-only reader gets `AUTHORIZATION_DENIED` for both; a caller holding `LeadScoreRecalculate` but not `Lead:edit` gets `LEAD_NOT_EDITABLE` — and their actual attempt on an *unscored* Lead really is refused with nothing stored |
| The list reads the projection, not the engine | e2e: the row's band pill and number come from the record; the columns and filters are metadata (`inList`/`inFilter`), asserted field by field in the schema suite |
| Freshness is shown, not smoothed over | browser: a Lead edited after scoring renders the `Đã cũ` pill and the server's sentence "The Lead has changed since this score was calculated", with coverage dropping to 33% when a signal went missing; the same Lead after a recalculation reads `Hiện hành` |
| History is paged and each row keeps its own reason | the drawer asks one page of 10, reports `Showing n of total`, disables "Load more" at the end, and expands a row to that evaluation's breakdown — the immutable record of what the score was made of then |
| A band is never colour alone, and the card works at 390px and under a keyboard | e2e: 390×844 detail page has zero horizontal overflow; the Recalculate button matches `:focus-visible` with a 3px outline and Enter runs the command (toast confirmed) |
| The words exist in both locales | the new suite block resolves all 24 keys the card uses in `en` and `vi`, and asserts the served labels are not their own codes |

## 4. Verification actually run

| Command | Outcome |
| --- | --- |
| `npx vitest run apps/api/test/lead-score-explanation.test.ts` | **16 passed** (12 LS.5 + 4 LS.7) |
| `npx vitest run --config apps/worker/vitest.config.ts` | **205 passed / 0 failed** (unchanged by this phase; re-run to confirm the shared `JobsService`/metadata edits left the worker green) |
| `npx vitest run apps/api/test/lead-score-schema.test.ts` | **25 passed** (24 LS.2 + 1 placement) |
| All nine LeadScore API files together | **218 passed / 0 failed** |
| Full `npx vitest run` (`apps/api/test` + `packages/*/src`) | **2,853 passed / 34 failed (2,887 tests, 200 files)** — zero `lead-score` failures; the 34 are the same seven pre-existing shared-state files as the LS.6 baseline (`ai-agent-runs`, `crm-chat-ai-agents-integration`, `crm-chat-docs-help`, `crm-chat-security`, `service-desk`, `service-desk-workflow`, `service-desk-sla`), and the +5 tests over that baseline are exactly this phase's four affordance/catalog tests and one metadata-placement test |
| `npx playwright test e2e/lead-score.spec.ts` | **3 passed** (list columns + filters, detail card + actions + history, 390px + keyboard) |
| Browser pass (browser-use, dev API 3030 + web 8080, Vietnamese UI) | list shows `Score Band` / `Score Value` with band pills; the filter disclosure reveals Score Value / Score Band / Score Status; the card renders number, band, movement `-20`, coverage `100%`, model version, both timestamps, the two-rule reason list; Recalculate posted 200 and the card and record refetched; the history drawer listed both evaluations |
| Playwright measurements | 390×844 detail: horizontal overflow `0px`, card visible; drawer open at 390px: `0px`; focus: `:focus-visible` true with `3px solid` outline; toast after keyboard Enter: `Điểm đã được lưu.` |
| `npm run typecheck` (API + web) | exit 0 |
| `npx eslint apps/api/src/lead-score apps/api/test/lead-score-*.ts apps/web/src e2e/lead-score.spec.ts --max-warnings=0` | exit 0 |
| `npm run build` in `apps/web` | built (the pre-existing chunk-size advisory only) |
| `node_modules/.bin/tsc -p apps/api/tsconfig.build.json` (for the e2e server) | exit 0 |
| residue check after the browser and e2e runs | `leadScore` settings row **0**, `AGENT_TEST_LS7*`/`E2E_LS7_*` records **0**, `LeadScore*` records **0**, `leadScore.*` job rows **0**, outbox rows naming this run's records **0**, Leads carrying a stored score **0**, Leads in the database **12** (the demo set, untouched), admin `locale` restored to its previous value |

## 5. Database and environment hygiene (AGENTS.md §3)

- Configured primary database only: no test database, no reset, no truncate, **no migration** (every field
  this phase touches is a JSONB attribute and the LS.2 indexes already cover the reads).
- `npm run db:seed` was run to push the metadata placement into `metadata_entries` — the same call
  `bootApi()` makes on every test boot, so it introduced no state the suites had not already written.
- Browser-test data was created through the API as `AGENT_TEST_LS7_UI_*` and removed by exact id, with
  `entity_links` and `outbox_events` first. **One record survived the first sweep and was found by the
  residue check:** a Lead created with `firstName: 'No', lastName: 'Company'` has no run marker in its stored
  `name`, because the entity layer recomposes a person's `name` from the parts. It was deleted by its exact
  id only after its attributes were re-read and matched, and the sweep pattern for Leads is now "marker in
  `name` **or** in `attrs->>'lastName'`" — recorded in §6 because it will bite the next UI phase.
- The e2e spec creates its own published model, rules and Lead, and removes them through the API in
  `afterAll` (soft delete, like every other spec in `e2e/`), switches Lead Score back off, and pins and
  restores the administrator's locale preference for its run.
- The dev API and web servers started for the browser pass were stopped at the end; `apps/api/dist` was
  rebuilt only because the e2e harness runs the compiled server.

## 6. What is deliberately not delivered

| Still owed | Phase | State today |
| --- | --- | --- |
| Model administration UI: model list, rule editor, preview picker, version diff, publish/archive confirmation, batch job status | LS.8 | the navigation entries exist because the entities are registered, but the screens are generic record views; choosing the active model and the debounce is still a settings write |
| Band-change notifications, engagement and email signals, decay sweep | LS.9 | such rules stay `skipped` in the engine and are refused at publish |
| Conversion wizard, Converted-To panel, duplicate review, field mapping | LS.10–LS.16 | refused with their own phases; the `converted` detail panel is the only surface, as LS.2 declared it |
| A score dashlet, score reports, and the Lead `list`/`edit` **layouts** as declared panels | LS.18 / LS.14 | the list columns come from metadata `inList` and the user's own column manager; no `list` layout is declared, so an administrator's arrangement is still the default field order |

Known limits worth stating before someone discovers them:

- **Server-rendered labels follow the reader's stored preference, and the SPA's own language control does not
  change it.** A user who picks Vietnamese in the UI while their account has no preference still gets English
  freshness and outcome labels, because the platform resolves `Accept-Language` server-side (plan §41.6). The
  card is honest about it — it shows what the server answered — but the mixed language is a Phase 41 gap, not
  a Lead Score one, and it is why the e2e spec pins the preference for its own run.
- **The card is mounted for `Lead` only.** The plan's §11.1 also asks for the score on a Contact (post
  conversion) and on a list badge; the badge half exists as a list column, and a Contact surface arrives with
  the conversion phase that populates it.
- **The empty shell card above the panel is pre-existing**: any entity with a declared detail layout renders
  the header-only card (70 entities today). LS.7 did not touch it, and it is a Phase 20 layout question.
- **History paging is offset-based**, matching the LS.5 command; a Lead whose evaluations are appended while
  the drawer is open can shift a page by one row. The total is shown, so the reader can tell.
