import type { ApiContext } from './boot-api.js';

/**
 * Test support for suites that flip a module's settings document through the API.
 *
 * A settings write is shared instance state (AGENTS.md §3.2), so a suite that turns a flag on has to put
 * the row back. The baseline is the **raw column**, never the endpoint's view: the view is the parsed
 * document, and storing it back writes a row without its `{version, settings, updatedAt, updatedBy}`
 * envelope, which the next reader silently treats as absent.
 *
 * Both functions take the booted context rather than a database handle, because `ctx.database` and
 * `ctx.database.db` are one character apart and passing the wrong one fails inside `afterAll` — which
 * leaves the shared row pointing at a test fixture for whoever runs next.
 */

export async function snapshotSettings(ctx: ApiContext, name: string): Promise<unknown> {
  const rows = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', name).execute();
  return rows[0]?.data ?? null;
}

/** Returns the stored document to exactly what it was, including "there was no row". */
export async function restoreSettings(ctx: ApiContext, name: string, baseline: unknown): Promise<void> {
  const db = ctx.database.db;
  if (baseline === null || baseline === undefined) {
    await db.deleteFrom('app_settings').where('name', '=', name).execute();
    return;
  }
  const serialized = JSON.stringify(baseline);
  await db
    .insertInto('app_settings')
    .values({ name, data: serialized, modified_at: new Date() })
    .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
    .execute();
}
