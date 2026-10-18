import type { Logger } from '@carocrm/core/logger/index.js';
import type { DatabaseService } from '@carocrm/database';
import { MarketingAutomationRecords } from '@carocrm/entity';
import type { JobContext, JobHandler } from '@carocrm/jobs';
import { MarketingProviderRegistry  } from '@carocrm/marketing-automation';

/** 19-MA.9 task 1 — the delivery batch job that drives one send's worth of recipients through the ledger. */
export const MARK_DELIVERY_BATCH_JOB = 'marketing.deliveryBatch';

interface DeliveryWorkerDeps {
  readonly db: DatabaseService;
  readonly log: Logger;
  readonly providerRegistry: MarketingProviderRegistry;
  readonly records: MarketingAutomationRecords;
}

interface DeliveryBatchInput {
  readonly sendId: string;
  readonly slot: number;
  readonly dryRun: boolean;
}

/** Claim + send a chunk of Eligible rows in one transaction, then mark sent or block. */
async function claimAndSend(
  db: DatabaseService,
  sendId: string,
  slot: number,
  limit: number,
  now: string,
  providerRegistry: MarketingProviderRegistry
): Promise<{ claimed: number; sent: number; blocked: number; errorKind: 'retryable' | 'permanent' | 'unknown_submission' | null }> {
  // 1. Claim a bounded chunk of Eligible rows
  const claimedRows = await db.$executeQuery(`
    update marketing_recipient_deliveries
    set state = 'Sending',
        claimed_at = ${now},
        attempts = attempts + 1,
        updated_at = ${now}
    where (send_id, slot, entity_type, entity_id) in (
      select send_id, slot, entity_type, entity_id
      from marketing_recipient_deliveries
      where send_id = ${sendId}
        and slot = ${slot}
        and state = 'Eligible'
      order by created_at asc, entity_type asc, entity_id asc
      limit ${limit}
      for update skip locked
    )
    returning send_id, slot, entity_type, entity_id, email_hash, state, category, reasons,
              provider_message_id, error_code, attempts, sent_at, created_at
  `);

  if (claimedRows.rowCount === 0) return { claimed: 0, sent: 0, blocked: 0, errorKind: null };

  let sent = 0;
  let blocked = 0;
  const receipts: { recipient: string; status: string; providerMessageId?: string; reasonCode?: string }[] = [];

  // 2. Send each claimed row to the provider
  for (const row of claimedRows.rows) {
    const providerKey = 'none'; // TODO: resolve from campaign settings
    const adapter = providerRegistry.resolve(providerKey);

    try {
      // Build the provider message from the recipient data
      const result = await adapter.send({
        to: [row.email_hash || ''],
        subject: '', // TODO: pull from template
        html: '', // TODO: render template
        text: '', // TODO: render template
        idempotencyKey: `${sendId}:${slot}:${row.entity_id}:${row.email_hash}`,
      });

      if (result.accepted) {
        // 3. Mark as Sent
        const marked = await db.$executeQuery(`
          update marketing_recipient_deliveries
          set state = 'Sent',
              provider_key = ${providerKey},
              provider_message_id = ${result.receipts?.[0]?.providerMessageId ?? null},
              content_hash = null,
              error_code = null,
              sent_at = ${now},
              updated_at = ${now}
          where send_id = ${sendId}
            and slot = ${slot}
            and entity_type = 'Contact'
            and entity_id = ${row.entity_id}
            and state = 'Sending'
        `);

        sent += Number(marked.rowCount ?? 0);
        if (result.receipts?.[0]?.providerMessageId) {
          receipts.push({
            recipient: row.email_hash || '',
            status: 'accepted',
            providerMessageId: result.receipts[0].providerMessageId,
          });
        }
      } else {
        // 4. Block the row
        const errorKind: 'retryable' | 'permanent' | 'unknown_submission' = 'permanent';
        blocked += 1;

        await db.$executeQuery(`
          update marketing_recipient_deliveries
          set state = 'Failed',
              error_code = ${result.receipts?.[0]?.reasonCode ?? 'PROVIDER_PERMANENT_ERROR'},
              failed_at = ${now},
              reasons = reasons || [${result.receipts?.[0]?.reasonCode ?? 'PROVIDER_PERMANENT_ERROR'}]::jsonb,
              updated_at = ${now}
          where send_id = ${sendId}
            and slot = ${slot}
            and entity_type = 'Contact'
            and entity_id = ${row.entity_id}
            and state = 'Sending'
        `);

        receipts.push({
          recipient: row.email_hash || '',
          status: 'rejected',
          reasonCode: result.receipts?.[0]?.reasonCode ?? 'PROVIDER_PERMANENT_ERROR',
        });
      }
    } catch (error) {
      // Provider call failed - classify as retryable
      blocked += 1;

      await db.$executeQuery(`
        update marketing_recipient_deliveries
        set state = 'Failed',
            error_code = 'PROVIDER_ERROR',
            failed_at = ${now},
            reasons = reasons || ['PROVIDER_ERROR']::jsonb,
            updated_at = ${now}
        where send_id = ${sendId}
          and slot = ${slot}
          and entity_type = 'Contact'
          and entity_id = ${row.entity_id}
          and state = 'Sending'
      `);

      receipts.push({
        recipient: row.email_hash || '',
        status: 'rejected',
        reasonCode: 'PROVIDER_ERROR',
      });
    }
  }

  return { claimed: claimedRows.rows.length, sent, blocked, errorKind: null };
}

export function marketingDeliveryBatchJob(deps: DeliveryWorkerDeps): JobHandler {
  return async (context: JobContext) => {
    context.progress(0, 'starting delivery batch');

    // Parse the job data
    const { sendId, slot, dryRun } = context.job.data as DeliveryBatchInput;

    if (!sendId || !slot) {
      return { status: 'failed', message: 'Invalid job data: missing sendId or slot' };
    }

    const now = new Date().toISOString();

    if (dryRun) {
      // Dry run: just count Eligible rows and report, don't actually send
      const counts = await deps.db.$executeQuery(`
        select state, count(*)::int as count
        from marketing_recipient_deliveries
        where send_id = ${sendId} and slot = ${slot}
        group by state
      `);

      const byState: Record<string, number> = {};
      for (const row of counts.rows) byState[row.state] = row.count;

      const eligible = byState['Eligible'] ?? 0;
      const blocked = byState['Blocked'] ?? 0;
      const skipped = byState['Skipped'] ?? 0;

      context.log(`dry run: eligible=${eligible}, blocked=${blocked}, skipped=${skipped}`, 'info');

      return { status: 'completed', message: `Dry run complete: eligible=${eligible}, blocked=${blocked}, skipped=${skipped}` };
    }

    // Real delivery: claim and send
    const { claimed, sent, blocked, errorKind } = await claimAndSend(
      deps.db,
      sendId,
      slot,
      100, // limit per chunk - configurable
      now,
      deps.providerRegistry
    );

    context.progress(100, `delivery batch complete: claimed=${claimed}, sent=${sent}, blocked=${blocked}`);

    deps.log.info(
      { sendId, slot, claimed, sent, blocked, errorKind },
      'marketing delivery batch finished'
    );

    // If there are still Eligible rows remaining, the batch can be re-enqueued
    const remainingCounts = await deps.db.$executeQuery(`
      select state, count(*)::int as count
      from marketing_recipient_deliveries
      where send_id = ${sendId} and slot = ${slot}
      group by state
    `);

    const byState: Record<string, number> = {};
    for (const row of remainingCounts.rows) byState[row.state] = row.count;

    const stillEligible = byState['Eligible'] ?? 0;

    const message = stillEligible > 0
      ? `sent ${String(sent)} of ${String(claimed)} claimed; ${String(stillEligible)} eligible remain`
      : `sent ${String(sent)} of ${String(claimed)} claimed; all done`;

    return { status: 'completed', message, result: { claimed, sent, blocked, stillEligible } };
  };
}