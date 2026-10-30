/**
 * The PATCH body helper (`apps/api/src/common/patch-schema.ts`).
 *
 * These are pure schema checks: zod 4 keeps a field default inside `.partial()`, so a PATCH body used
 * to arrive at the service holding values the client never sent. The helper is the single place that
 * fixes it, and this suite pins the three properties every PATCH endpoint depends on.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { patchOf } from '../src/common/patch-schema.js';

const MailboxSchema = z.object({
  name: z.string().trim().min(1).max(190),
  smtpPort: z.number().int().min(1).max(65_535).default(587),
  isActive: z.boolean().default(true),
  signature: z.string().max(1000).nullable().optional(),
});

describe('patchOf', () => {
  it('keeps an absent key absent instead of filling its default', () => {
    const patch = patchOf(MailboxSchema);
    // zod 4 alone would answer `{ smtpPort: 587, isActive: true }` here and a deep merge would then
    // rewrite both columns.
    expect(patch.parse({ name: 'Inbox' })).toEqual({ name: 'Inbox' });
    expect(patch.parse({})).toEqual({});
  });

  it('still validates and keeps a value the client did send', () => {
    const patch = patchOf(MailboxSchema);
    expect(patch.parse({ smtpPort: 25, isActive: false })).toEqual({ smtpPort: 25, isActive: false });
    expect(patch.safeParse({ smtpPort: 0 }).success).toBe(false);
    expect(patch.safeParse({ name: '' }).success).toBe(false);
  });

  it('patches a nested object key by key and leaves its siblings out', () => {
    const settings = z.object({
      features: z
        .object({
          chat: z.boolean().default(true),
          voice: z.boolean().default(false),
        })
        .default({}),
      limits: z.object({ maxTurns: z.number().int().min(1).default(10) }),
    });

    const patch = patchOf(settings);
    expect(patch.parse({ features: { voice: true } })).toEqual({ features: { voice: true } });
    expect(patch.parse({ limits: {} })).toEqual({ limits: {} });
  });

  it('inherits the source unknown-key policy', () => {
    const strictPatch = patchOf(MailboxSchema.strict());
    expect(strictPatch.safeParse({ unknownKey: 1 }).success).toBe(false);

    const strippingPatch = patchOf(MailboxSchema);
    expect(strippingPatch.parse({ name: 'Inbox', unknownKey: 1 })).toEqual({ name: 'Inbox' });
  });

  it('survives the omit/extend derivations call sites rely on', () => {
    const create = z.object({ projectId: z.string().min(1), taskType: z.enum(['Task', 'Milestone']).default('Task') });
    const update = patchOf(create).omit({ projectId: true });
    expect(update.parse({ taskType: 'Milestone' })).toEqual({ taskType: 'Milestone' });
    expect(update.parse({})).toEqual({});

    const withTarget = patchOf(create).extend({ groupId: z.string().min(1) });
    expect(withTarget.safeParse({ groupId: 'g1' }).success).toBe(true);
  });
});
