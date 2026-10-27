// Ad-hoc diagnostic: list active RoutingRule rows (read-only).
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const url = env.split('\n').find((line) => line.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length).trim();

async function main() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const rules = await client.query(
    "select attrs->>'name' name, attrs->>'sortOrder' sort, attrs->>'conditions' conds, attrs->>'routedObjectType' obj from entity_records where entity_type='RoutingRule' and deleted_at is null order by (attrs->>'sortOrder')::int",
  );
  console.log('=== RoutingRule rows ===');
  for (const x of rules.rows) console.log(x.name, '| sort', x.sort, '| obj', x.obj, '|', x.conds);
  const queues = await client.query(
    "select id, attrs->>'name' as name, attrs->>'sortOrder' as sort, created_at from entity_records where entity_type='CaseQueue' and deleted_at is null order by created_at asc limit 25",
  );
  console.log('=== CaseQueue rows (oldest first) ===');
  for (const row of queues.rows) console.log(row);
  await client.end();
}

main();
