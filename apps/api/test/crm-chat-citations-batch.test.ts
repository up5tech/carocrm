import { describe, expect, it } from 'vitest';

import { CRMChatCitationService } from '../src/crm-chat/crm-chat-citations.service.js';
import type { AIAgentMessagesTable } from '../src/database/database.service.js';

/**
 * Phase 19-CHAT.28 — citation materialisation for a page is batched, not per-message.
 *
 * The stub counts every store call: a 30-message page whose answers cite the same entity must cost
 * one citation read, one entity read and one insert — not one entity read per message.
 */

function message(id: string, refs: readonly { entity: string; id: string }[]): AIAgentMessagesTable {
  return {
    id,
    conversation_id: 'conv-1',
    seq: 1,
    role: 'assistant',
    content: 'answer',
    content_meta: { refs },
    run_id: null,
    redaction: 'none',
    created_at: new Date(),
  } as unknown as AIAgentMessagesTable;
}

function harness(options: { storedRows?: Record<string, unknown>[]; readableIds?: ReadonlySet<string> }) {
  const calls = { citationSelects: 0, inserts: 0, entityLists: 0, docsReads: 0 };
  const storedRows = options.storedRows ?? [];
  // Rows the stubbed insert accepted; the post-insert re-read returns them, as the real table would.
  const insertedRows: Record<string, unknown>[] = [];

  const chainFor = (rows: () => Record<string, unknown>[]) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['selectAll', 'select', 'where', 'orderBy', 'limit', 'offset']) {
      chain[method] = () => chain;
    }
    chain['execute'] = async () => rows();
    chain['executeTakeFirst'] = async () => rows()[0] ?? null;
    return chain;
  };

  const db = {
    selectFrom: (table: string) => {
      if (table === 'crm_chat_citations') {
        calls.citationSelects += 1;
        return chainFor(() => (insertedRows.length > 0 ? insertedRows : storedRows));
      }
      return chainFor(() => []);
    },
    insertInto: () => ({
      values: (rows: Record<string, unknown>[]) => {
        insertedRows.push(...rows);
        return {
          onConflict: () => ({
            execute: async () => {
              calls.inserts += 1;
            },
          }),
        };
      },
    }),
  };

  const entities = {
    list: async (entity: string, query: { where?: { value?: string[] } }) => {
      calls.entityLists += 1;
      const wanted = new Set(query.where?.value ?? []);
      return {
        list: [...wanted]
          .filter((id) => options.readableIds === undefined || options.readableIds.has(`${entity}:${id}`))
          .map((id) => ({ id, entity, name: `Record ${id}` })),
        offset: 0,
        count: wanted.size,
      };
    },
    get: async () => {
      throw new Error('per-record get must not be used by the batch path');
    },
  };

  const docs = {
    page: async () => {
      calls.docsReads += 1;
      return null;
    },
  };

  const service = new CRMChatCitationService(
    { db } as never,
    entities as never,
    docs as never,
  );
  return { service, calls };
}

describe('CRMChatCitationService.forMessages (19-CHAT.28)', () => {
  it('materialises a 30-message page with one citation read, one entity read and one insert', async () => {
    // 15 assistant answers, each citing the same two Account records: 30 refs, 2 unique records.
    const messages = Array.from({ length: 15 }, (_, index) =>
      message(`msg-${String(index)}`, [
        { entity: 'Account', id: 'acc-1' },
        { entity: 'Account', id: 'acc-2' },
      ]),
    );
    const { service, calls } = harness({});

    const result = await service.forMessages(messages);

    expect(result.size).toBe(15);
    for (const views of result.values()) {
      expect(views).toHaveLength(2);
      expect(views[0]?.route).toBe('/entity/Account/acc-1');
    }
    expect(calls.citationSelects).toBe(2); // initial read + post-insert read
    expect(calls.entityLists).toBe(1); // one batched read for the entity, not 30
    expect(calls.inserts).toBe(1); // one multi-row insert
    expect(calls.docsReads).toBe(0);
  });

  it('returns stored citations without touching the entity engine', async () => {
    const stored = [
      {
        id: 'msg-1:0',
        message_id: 'msg-1',
        conversation_id: 'conv-1',
        ordinal: 0,
        source_type: 'crm_record',
        entity: 'Account',
        record_id: 'acc-1',
        label: 'Acme',
        route: '/entity/Account/acc-1',
        rechecked_at: new Date(),
        created_at: new Date(),
      },
    ];
    const { service, calls } = harness({ storedRows: stored });
    const result = await service.forMessages([message('msg-1', [{ entity: 'Account', id: 'acc-1' }])]);

    expect(result.get('msg-1')).toHaveLength(1);
    expect(result.get('msg-1')?.[0]?.label).toBe('Acme');
    expect(calls.entityLists).toBe(0);
    expect(calls.inserts).toBe(0);
  });

  it('hides references the caller cannot read instead of erroring', async () => {
    const messages = [
      message('msg-1', [
        { entity: 'Account', id: 'acc-1' },
        { entity: 'Account', id: 'acc-secret' },
      ]),
    ];
    const { service } = harness({ readableIds: new Set(['Account:acc-1']) });
    const result = await service.forMessages(messages);

    const views = result.get('msg-1') ?? [];
    expect(views).toHaveLength(1);
    expect(views[0]?.recordId).toBe('acc-1');
  });
});
