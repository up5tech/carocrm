import type { Queryable, QueryResultLike, Row } from '../db.js';

/**
 * Test double for the `Queryable` port: records every statement and replies with canned
 * rows per SQL fragment. Lives under `src/testing` which `tsconfig.build.json` excludes, so
 * it never reaches `dist/`.
 */
export interface CapturedQuery {
  sql: string;
  params: readonly unknown[];
}

export type FakeResponder = (params: readonly unknown[]) => QueryResultLike | Error;

export function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function result(rows: Row[] = [], rowCount: number | null = null): QueryResultLike {
  return { rows, rowCount: rowCount ?? rows.length };
}

export class FakeDb implements Queryable {
  readonly calls: CapturedQuery[] = [];

  private readonly responders = new Map<string, FakeResponder>();
  private fallbackRows: Row[] = [];

  /** Response for any statement whose normalized SQL contains `fragment`. */
  on(fragment: string, responder: FakeResponder): this {
    this.responders.set(normalizeSql(fragment), responder);
    return this;
  }

  returns(fragment: string, rows: Row[], rowCount?: number | null): this {
    return this.on(fragment, () => result(rows, rowCount));
  }

  throws(fragment: string, error: Error): this {
    return this.on(fragment, () => error);
  }

  /** Rows returned by any unmatched statement (defaults to an empty result). */
  withFallback(rows: Row[]): this {
    this.fallbackRows = rows;
    return this;
  }

  callsFor(fragment: string): CapturedQuery[] {
    const needle = normalizeSql(fragment);
    return this.calls.filter((call) => normalizeSql(call.sql).includes(needle));
  }

  /** Statements containing `included` but not `excluded` (statements can share prefixes). */
  callsMatching(included: string, excluded?: string): CapturedQuery[] {
    const needle = normalizeSql(included);
    const anti = excluded === undefined ? '' : normalizeSql(excluded);
    return this.calls.filter((call) => {
      const sql = normalizeSql(call.sql);
      return sql.includes(needle) && (anti === '' || !sql.includes(anti));
    });
  }

  lastMatching(included: string, excluded?: string): CapturedQuery | undefined {
    const matched = this.callsMatching(included, excluded);
    return matched[matched.length - 1];
  }

  lastCall(fragment: string): CapturedQuery | undefined {
    const matched = this.callsFor(fragment);
    return matched[matched.length - 1];
  }

  reset(): void {
    this.calls.length = 0;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultLike> {
    this.calls.push({ sql, params });
    const normalized = normalizeSql(sql);
    for (const [fragment, responder] of this.responders) {
      if (!normalized.includes(fragment)) continue;
      const reply = responder(params);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    return result(this.fallbackRows);
  }
}

/** Convenience: a claimed `outbox_events` row in the shape the poller reads. */
export function outboxRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'event-1',
    event_type: 'system.noop',
    payload: { hello: 'world' },
    attempts: 0,
    ...overrides,
  };
}
