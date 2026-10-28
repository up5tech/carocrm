/**
 * Phase 22.1 — test-run identity and ownership helpers.
 *
 * These helpers encode the test-data policy from `docs/quality/test-strategy.md`:
 * every write-capable test run must tag the records it creates with a unique run id
 * (`AGENT_TEST_<runId>_<purpose>`) and clean up exactly those records on teardown.
 *
 * They are intentionally tiny — a convention seed, not a parallel mock framework.
 */
import { randomUUID } from 'node:crypto';

/** A per-process stable run id; override with `AGENT_TEST_RUN_ID` to correlate across forks/files. */
export function agentTestRunId(): string {
  if (process.env.AGENT_TEST_RUN_ID) return process.env.AGENT_TEST_RUN_ID;
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  process.env.AGENT_TEST_RUN_ID = id;
  return id;
}

/**
 * Build a record name that carries the test run marker, e.g.
 * `AGENT_TEST_a1b2c3d4_lead`. Use it for any `name`-bearing entity field so cleanup
 * can later `DELETE FROM entity_records WHERE name LIKE 'AGENT_TEST_<runId>_%'`.
 */
export function testName(purpose: string): string {
  return `AGENT_TEST_${agentTestRunId()}_${purpose}`;
}

/**
 * Minimal owned-record registry for exact-ID cleanup. Tests register the ids they
 * create; `ownedIds` is read by teardown helpers that delete only those rows.
 */
const owned = new Set<string>();
const ownedByTable = new Map<string, Set<string>>();

export function trackRecord(table: string, id: string): string {
  owned.add(`${table}:${id}`);
  let set = ownedByTable.get(table);
  if (!set) {
    set = new Set<string>();
    ownedByTable.set(table, set);
  }
  set.add(id);
  return id;
}

export function ownedIdsFor(table: string): string[] {
  return [...(ownedByTable.get(table) ?? [])];
}

export function resetOwnedRecords(): void {
  owned.clear();
  ownedByTable.clear();
}
