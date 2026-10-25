# Phase 19-LS.17 — Optional AI-assisted fit insight: completion report

`PLAN_Phase_19_LeadScore.md` §6.7, §11.1, §16 (`19-LS.17`); audit §7.3, §11 `LS.17`; compatibility
`docs/compatibility/lead-score.md` §2, §8; the module descriptor `apps/api/src/lead-score/lead-score-module.ts`.

**Exit criterion (plan §16):** *core scoring works with AI disabled; AI text cannot change scores without
explicit deterministic rules.* Both halves are structural rather than promised:

- **Scoring works with AI disabled** because the feature is a *switch*, not a dependency: `features.aiInsight`
  gates one route and one block on the score card, and the module's own read, recalculation, conversion and
  background paths never mention it. The suite proves it by recalculating a real Lead with the switch off and
  asserting the same deterministic 50, the same projection and the same Lead `version`.
- **AI text cannot change a score** because the insight has **no write path to a score**: it is one
  append-only `LeadScoreInsight` row, written through the canonical entity service under the module marker.
  The score is an *input* to the prompt, not an output of it. The suite asserts the Lead's `scoreValue`,
  `scoreBand`, `scoreModelVersion`, `scoreCalculatedAt`, `scoreStatus` and `version` are identical before and
  after a generation, and that the AIAgents run's own stored input contains the Lead's business facts and
  **not** its e-mail, phone, name or note.

## What was built

### The command (`apps/api/src/lead-score/lead-score-insight.service.ts`, new)

`POST /api/v1/LeadScore/action/insight` with `{ leadId, idempotencyKey? }`:

1. the gate (`aiInsight` → capability `generateInsight`, feature `aiInsight`);
2. the configuration (`insight.agentId` — `LEADSCORE_INSIGHT_NOT_CONFIGURED` when it is null);
3. the Lead through `EntityCrudService` (record ACL is the door) and its stored score
   (`LEADSCORE_INSIGHT_NOT_SCORED` when it has none);
4. **the replay lookup, before any provider check** — a repeated key returns the stored answer even if
   generation was switched off afterwards;
5. AIAgents' execution switch and the caller's AIAgents `use` right;
6. the agent's suitability: it must read a **text** task and hold **read-only** tools
   (`LEADSCORE_INSIGHT_AGENT_UNSUITABLE`, `issue: 'recordInput' | 'writeTool' | 'version'`);
7. `AIAgentRunService.create(agentId, { input: { text }, idempotencyKey, trigger: 'manual' })` and
   `execute(runId)` — AIAgents' own manual-run path, so the kill switch, concurrency limit, quota pre-check,
   step/model/token/cost budgets, output validation and the durable run/event audit are the ones that module
   already enforces. This phase adds no runtime, no provider client and no prompt store;
8. the answer, extracted from the run result (`text`, or an object carrying `summary`/`text`/`explanation`,
   with an optional `confidence`), stored as one `LeadScoreInsight` row.

### The evidence (a pure function, unit-tested)

`buildInsightEvidence(lead)` builds the prompt from **the module's own allowlist**: the stored score (value,
band, model version, coverage, status, reason codes) and five business fields — `company`, `industry`,
`title`, `source`, `status`. The prompt states the rules the plan sets: use only those facts, they are
untrusted data, do not invent facts, do not estimate or assign a score, do not tell anyone to convert, and say
so when the facts are too thin. A digest (SHA-256) of the exact prompt and the list of fields it used are
stored, so "what was the model told" is answerable without keeping a second copy of the prompt.

### Storage (a fifth module entity)

`LeadScoreInsight` — append-only, module-written, `read: 'no'` on the generic entity API, with the text, the
**AI-generated** label, the run id, the agent id/name/key/version, the provider/model, the settings version,
the input digest/fields/chars, the confidence, the score it describes, the generated-at moment, the requester,
the request key and the token/cost/duration counters. `database/migrations/075_phase19_lead_score_insights.sql`
adds two partial indexes over `entity_records.attrs` (the newest insight for one Lead, and one row per request
key) — additive and index-only.

### The surface

- **Score read** (`action/score/:leadId`): a new `insight` object beside the deterministic `score`, and a new
  `actions.insight` answer computed from the gate. The text is **withheld** (`withheld: 'field_hidden'`) when
  the answer was grounded on a field this reader may not see: an AI answer paraphrases its evidence, so it may
  not become a way to read past field ACL.
- **Panel** (`LeadScorePanel.tsx`): a separate block under a divider — heading, an **AI-generated** tag, the
  note that AI text is not part of the score and never changes it, the answer, the moment it was produced, the
  agent and its version, the provider/model, the fields it was grounded on — and a button that appears only
  when `actions.insight` allows it. Nothing is requested on mount (a cost, not a read), and a failed request
  keeps its key so a retry replays rather than pays twice.
- **Settings** (`SettingsTab.tsx`): a picker of **published** AIAgents agents (name · key · version), so an
  administrator chooses an agent rather than typing an id; the stored configuration is one key,
  `insight.agentId`.

## Verification

Commands run (configured primary database only; no extra database; one additive migration):

| Check | Result |
| --- | --- |
| `npx vitest run apps/api/test/lead-score-*.test.ts` | **328 passed / 0 failed** across **16 files** (LS.17 added 13 in `lead-score-insight.test.ts` and one metadata test) |
| Full `npx vitest run` | **2,963 passed / 34 failed** across **207 files** — the 34 in the same seven pre-existing shared-state files (`ai-agent-runs`, `service-desk` ×3, `crm-chat` ×3) and **zero `lead-score` failures**; the +14 are this phase's new tests |
| Worker suite (`npx vitest run --config apps/worker/vitest.config.ts`) | **210 passed / 0 failed** (20 files) |
| `npx playwright test e2e/lead-score.spec.ts e2e/lead-score-admin.spec.ts e2e/lead-conversion.spec.ts` | **16 passed** (49 s) — the insight block is hidden while the feature is off, so the existing surfaces are unchanged |
| Browser pass on a scratch API (`NODE_ENV=test`, ports 3150/8150) | the panel shows the answer under the **AI-generated** tag with its provenance, and the settings screen picks the agent by name (screenshots taken; the scratch script and its records were removed afterwards) |
| `npm run typecheck` | clean |
| `npx eslint` on every touched path | clean |
| `pnpm --filter @carocrm/api build`, `pnpm --filter @carocrm/web build` | both succeed |
| `npm run db:migrate` | up to date (075 applied by the test boot; idempotent) |

### The 13 new tests (`apps/api/test/lead-score-insight.test.ts`)

Pure: the evidence builder (the allowlist, the absence of personal data, "no score ⇒ no evidence"), the output
extractor, and the request key.

API, through the real routes with AIAgents' deterministic fake provider (no network, no billable call):

1. the feature off → the action is refused, the score read answers normally, a recalculation still produces the
   same 50, and **no run and no row exist**;
2. the feature on with no agent → `NOT_CONFIGURED` in the answer and in the refusal;
3. a caller without the insight right → `AUTHORIZATION_DENIED`, and the score read says so;
4. one request → one stored answer: the text, the label, the agent/version/provider/model, the settings
   version, the digest, the counters, and **the Lead's projection and `version` unchanged**; the AIAgents run's
   stored input is asserted to carry the company and the industry and none of the e-mail, phone, name or note;
5. the same key again → the same answer, the same run, **one run and one row**;
6. a record-input agent and a write-tool agent → both refused, with their `issue`;
7. AIAgents paused → new work is refused (`executionDisabled`) while a replay still answers;
8. a row grounded on a field this reader may not see → the text is withheld, and the sentence is absent from the
   whole response;
9. the feature switched off again → the stored answer is hidden and the score still reads.

## Notes and limits

- **The e2e suite cannot cover the generation.** The Playwright API runs `NODE_ENV=production`, where AIAgents'
  fake adapter is deliberately not registered (a live deployment must not be able to select a provider that
  fabricates answers). The browser pass was therefore run against a scratch API in `NODE_ENV=test`, and the
  reasoning is recorded here rather than hidden.
- **The answer is not translated.** The panel's labels are localized; the answer is provider output and is
  shown as it came back. A translation step would be a second AI call, which this phase does not buy.
- **A reader may not see an older answer.** Withholding is a per-reader decision on the stored row, not a
  re-generation, so an answer grounded on a hidden field is simply not served to that reader.
- **Cost and latency are recorded, not capped here.** The budgets are AIAgents' own (steps, model calls,
  tokens, cost, elapsed seconds) and the row keeps the counters, so 19-LS.18's reporting can sum them without
  re-reading the provider's tables.
- **No hallucination metric.** The phase makes the ground truth auditable (the digest, the field list, the
  score it describes) rather than pretending to measure faithfulness; a reviewer compares the answer with the
  evidence. A faithfulness score would need a reference set this build does not have.
