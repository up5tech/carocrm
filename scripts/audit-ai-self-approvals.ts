/* eslint-disable no-console -- the audit report this CLI prints is its deliverable. */
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { getDatabaseUrl,loadEnv } from '../database/env.js';

/**
 * Phase 19-AI.21 — read-only audit of the approvals that decided themselves.
 *
 * The self-approval policy (`plans/PLAN_Phase_19_AI_Agents.md` §24, `19-AI.21`) is enforced in
 * service code, so an installation that switches it on inherits the history of the decisions that
 * were already made. This script answers one question — *were any approvals decided by the person
 * they were requested from?* — so an operator can see the exposure before they flip the switch.
 *
 * It is **read-only**: one SELECT, no writes, no locks beyond the statement itself, and no
 * connection string in the output. The primary database is the configured project database
 * (AGENTS.md §3.1); nothing is created, reset or dropped.
 *
 * Usage: `pnpm tsx scripts/audit-ai-self-approvals.ts`
 */

const here = dirname(fileURLToPath(import.meta.url));
loadEnv(resolve(here, '..'));

interface SelfDecisionRow {
  readonly id: string;
  readonly run_id: string;
  readonly action_class: string;
  readonly status: string;
  readonly decided_at: Date | null;
}

interface SummaryRow {
  readonly action_class: string;
  readonly status: string;
  readonly total: string;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: getDatabaseUrl(), max: 1 });
  try {
    const summary = await pool.query<SummaryRow>(
      `SELECT action_class, status, count(*)::text AS total
         FROM ai_agent_approvals
        WHERE decided_by_user_id IS NOT NULL
          AND requested_by_user_id IS NOT NULL
          AND decided_by_user_id = requested_by_user_id
        GROUP BY action_class, status
        ORDER BY action_class, status`,
    );
    const rows = await pool.query<SelfDecisionRow>(
      `SELECT id, run_id, action_class, status, decided_at
         FROM ai_agent_approvals
        WHERE decided_by_user_id IS NOT NULL
          AND requested_by_user_id IS NOT NULL
          AND decided_by_user_id = requested_by_user_id
        ORDER BY decided_at DESC NULLS LAST
        LIMIT 100`,
    );

    const total = summary.rows.reduce((sum, row) => sum + Number(row.total), 0);
    console.log(`Self-decided approvals: ${total}`);
    for (const row of summary.rows) {
      console.log(`  ${row.action_class} / ${row.status}: ${row.total}`);
    }
    for (const row of rows.rows) {
      console.log(
        `  - ${row.id} run=${row.run_id} ${row.action_class} ${row.status} ${
          row.decided_at === null ? '' : row.decided_at.toISOString()
        }`,
      );
    }
    if (total === 0) console.log('No approval was decided by its requester.');
  } finally {
    await pool.end();
  }
}

await main();
