import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import argon2 from 'argon2';
import pg from 'pg';

import { DEFAULT_ONBOARDING_TEMPLATE } from '../apps/api/src/customer-success/customer-success-defaults.js';
import { DEFAULT_DOCUMENT_TEMPLATES } from '../apps/api/src/sales/document/document-template-defaults.js';
import { DEFAULT_NUMBER_SERIES } from '../apps/api/src/sales/document/number-series-defaults.js';
import { getDatabaseUrl,loadEnv } from './env.js';
import { runMigrations } from './migrate.js';
import { coreMetadata } from './seed-metadata.js';

const here = dirname(fileURLToPath(import.meta.url));
void here;

export interface SeedOptions {
  adminLogin?: string;
  adminPassword?: string;
  resetAdminPassword?: boolean;
  demo?: boolean;
}

/**
 * Phase 19 default configuration rows (PLAN_Phase_19_Projects.md §14.1): one default Project Board
 * with its stages, and the three built-in project roles. They are ordinary `entity_records` rows so
 * the Entity Engine, admin UI and ACL treat them like any other configuration record.
 *
 * Fixed ids + `ON CONFLICT DO NOTHING`: the seed runs on every boot and on every test run, and it
 * must neither duplicate a row nor overwrite an administrator's edits.
 */
const DEFAULT_PROJECT_BOARD_ID = 'projectBoardDefault';

const DEFAULT_PROJECT_STAGES: readonly { id: string; key: string; name: string; statusValue: string; sortOrder: number }[] = [
  { id: 'projectStageNotStarted', key: 'notStarted', name: 'Not Started', statusValue: 'Not Started', sortOrder: 0 },
  { id: 'projectStageInProgress', key: 'inProgress', name: 'In Progress', statusValue: 'Started', sortOrder: 10 },
  { id: 'projectStageBlocked', key: 'blocked', name: 'Blocked', statusValue: 'Started', sortOrder: 20 },
  { id: 'projectStageReview', key: 'review', name: 'Review', statusValue: 'Started', sortOrder: 30 },
  { id: 'projectStageDone', key: 'done', name: 'Done', statusValue: 'Completed', sortOrder: 40 },
  { id: 'projectStageCanceled', key: 'canceled', name: 'Canceled', statusValue: 'Canceled', sortOrder: 50 },
  { id: 'projectStageDeferred', key: 'deferred', name: 'Deferred', statusValue: 'Deferred', sortOrder: 60 },
];

/** Built-in roles (PLAN §4.4). `isSystem` marks them as undeletable configuration, not user data. */
const DEFAULT_PROJECT_ROLES: readonly { id: string; name: string; policy: Record<string, string> }[] = [
  {
    id: 'projectRoleOwner',
    name: 'Owner',
    policy: {
      taskCreate: 'yes', assignmentScope: 'all', taskReadScope: 'all', taskStreamScope: 'all', taskEditScope: 'all',
      stageMoveScope: 'all', taskDeleteScope: 'all', projectStreamAccess: 'yes', groupManage: 'yes', memberManage: 'yes', projectEdit: 'yes',
    },
  },
  {
    id: 'projectRoleEditor',
    name: 'Editor',
    policy: {
      taskCreate: 'yes', assignmentScope: 'all', taskReadScope: 'all', taskStreamScope: 'all', taskEditScope: 'all',
      stageMoveScope: 'all', taskDeleteScope: 'all', projectStreamAccess: 'yes', groupManage: 'yes', memberManage: 'no', projectEdit: 'yes',
    },
  },
  {
    id: 'projectRoleMember',
    name: 'Member',
    policy: {
      taskCreate: 'yes', assignmentScope: 'all', taskReadScope: 'all', taskStreamScope: 'own', taskEditScope: 'own',
      stageMoveScope: 'assigned', taskDeleteScope: 'no', projectStreamAccess: 'yes', groupManage: 'no', memberManage: 'no', projectEdit: 'no',
    },
  },
];

/**
 * Phase 19-CS.6.6 — the default onboarding playbook (PLAN_Phase_19_Customer_Success.md §6.6).
 *
 * Without a template, `startOnboarding` falls back to manual tracking: correct, but a fresh
 * installation would never show the playbook machinery it just installed. This is ordinary
 * configuration in `entity_records`, with a fixed id and `ON CONFLICT DO NOTHING` so re-running the
 * seed never duplicates it and never overwrites an operator's edits to the template. The record's
 * shape is declared next to the service that reads it (`customer-success-defaults.ts`).
 */
async function seedCustomerSuccessSystemRows(pool: pg.Pool): Promise<void> {
  const template = DEFAULT_ONBOARDING_TEMPLATE;
  await pool.query(
    `INSERT INTO entity_records (id, entity_type, name, attrs, created_at, modified_at, version)
     VALUES ($1, 'CustomerSuccessPlaybookTemplate', $2, $3, now(), now(), 1) ON CONFLICT (id) DO NOTHING`,
    [template.id, template.name, JSON.stringify(template.attrs)],
  );
}

async function seedSalesNumberSeries(pool: pg.Pool): Promise<void> {
  for (const series of DEFAULT_NUMBER_SERIES) {
    await pool.query(
      `INSERT INTO sales_number_series (id, code, label, prefix, padding, next_number, allocation, active, created_at, modified_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, TRUE, now(), now())
       ON CONFLICT (code) DO NOTHING`,
      [`sns_${series.code}`, series.code, series.label, series.prefix, series.padding ?? 6, series.allocation ?? 'issuance'],
    );
  }
}

async function seedProjectSystemRows(pool: pg.Pool): Promise<void> {
  const insert = async (id: string, entityType: string, name: string, attrs: Record<string, unknown>): Promise<void> => {
    await pool.query(
      `INSERT INTO entity_records (id, entity_type, name, attrs, created_at, modified_at, version)
       VALUES ($1, $2, $3, $4, now(), now(), 1) ON CONFLICT (id) DO NOTHING`,
      [id, entityType, name, JSON.stringify(attrs)],
    );
  };

  await insert(DEFAULT_PROJECT_BOARD_ID, 'ProjectBoard', 'Default board', {
    description: 'Seeded by the Projects module; stages define the task status mapping.',
    isDefault: true,
  });
  for (const stage of DEFAULT_PROJECT_STAGES) {
    await insert(stage.id, 'ProjectBoardStage', stage.name, {
      boardId: DEFAULT_PROJECT_BOARD_ID,
      key: stage.key,
      sortOrder: stage.sortOrder,
      statusValue: stage.statusValue,
    });
  }
  for (const role of DEFAULT_PROJECT_ROLES) {
    await insert(role.id, 'ProjectRole', role.name, { isSystem: true, ...role.policy });
  }
}

export async function seed(connectionString: string, options: SeedOptions = {}): Promise<void> {
  await runMigrations(connectionString);
  const adminLogin = options.adminLogin ?? process.env.SEED_ADMIN_LOGIN ?? 'admin';
  const adminPassword = options.adminPassword ?? process.env.SEED_ADMIN_PASSWORD ?? 'admin';
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });

    await pool.query(
      `INSERT INTO roles (id, name, permissions) VALUES ($1, 'System Administrator', $2) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      ['sysAdmin', { '*' : { create: 'yes', read: 'yes', edit: 'yes', delete: 'yes', stream: 'yes', export: 'yes', massUpdate: 'yes' } }],
    );
    await pool.query(
      `INSERT INTO roles (id, name, permissions) VALUES ($1, 'Default users', $2) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      ['noAccess', {}],
    );

    // Phase 18 — default portal, its portal role, navigation and dashboard (PLAN §37).
    // The portal role grants entity-level read only; portal record visibility (contact/account
    // one-hop) is enforced by the portal ACL policy, never by the internal role tables.
    //
    // Phase 19-SD.11 — the same role exposes the canonical `Case` entity to customers. Record scope
    // stays the contact/account neighbourhood; field permissions hide assignment, routing,
    // SLA/escalation and merge internals, and deny direct status edits (state changes remain staff
    // commands). Create and stream are allowed so a customer can raise a case and reply.
    const portalCaseFields: Record<string, Record<string, string>> = {};
    for (const field of [
      'assignedUserId', 'teams', 'teamId', 'queueId', 'routingRuleId', 'leadId', 'slaPolicyId',
      'slaState', 'isEscalated', 'escalationLevel', 'escalatedAt', 'resolvedById',
      'isHiddenFromPortal', 'mergedIntoCaseId', 'lastAgentResponseAt', 'lastCustomerResponseAt',
      'firstResponseAt', 'createdById', 'modifiedById',
    ]) {
      portalCaseFields[field] = { read: 'no', edit: 'no' };
    }
    for (const field of [
      'caseNumber', 'status', 'priority', 'severity', 'type', 'source', 'resolutionCode',
      'resolutionSummary', 'resolvedAt', 'closedAt', 'reopenedAt', 'accountId', 'contactId',
      'lastActivityAt',
    ]) {
      portalCaseFields[field] = { read: 'yes', edit: 'no' };
    }
    portalCaseFields['name'] = { read: 'yes', edit: 'yes' };
    portalCaseFields['description'] = { read: 'yes', edit: 'yes' };
    portalCaseFields['requesterName'] = { read: 'yes', edit: 'yes' };
    portalCaseFields['requesterEmail'] = { read: 'yes', edit: 'yes' };

    await pool.query(
      `INSERT INTO portals (id, name, url_path, settings) VALUES ($1, 'Customer Portal', '/portal', '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      ['portalCustomer'],
    );
    await pool.query(
      `INSERT INTO portal_roles (id, name, permissions, field_permissions) VALUES ($1, 'Portal Customer', $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
         permissions = portal_roles.permissions || EXCLUDED.permissions,
         field_permissions = CASE
           WHEN portal_roles.field_permissions = '{}'::jsonb THEN EXCLUDED.field_permissions
           ELSE jsonb_set(
             portal_roles.field_permissions,
             '{Case}',
             COALESCE(portal_roles.field_permissions -> 'Case', '{}'::jsonb) || (EXCLUDED.field_permissions -> 'Case'),
             TRUE
           )
         END`,
      [
        'portalCustomerRole',
        {
          Account: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' },
          Contact: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' },
          Opportunity: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' },
          Task: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' },
          Email: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' },
          // SD.11 portal self-service: read visible cases, raise a case, post customer-visible replies.
          Case: { read: 'all', create: 'yes', edit: 'no', delete: 'no', stream: 'yes' },
        },
        { Case: portalCaseFields },
      ],
    );
    await pool.query(
      `INSERT INTO portals_portal_roles (portal_id, portal_role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      ['portalCustomer', 'portalCustomerRole'],
    );
    for (const item of [
      { id: 'portalNavHome', label: 'Home', entity: null, route: '/portal', icon: 'home', position: 0 },
      { id: 'portalNavAccount', label: 'My Account', entity: 'Account', route: null, icon: 'apartment', position: 1 },
      { id: 'portalNavContacts', label: 'Contacts', entity: 'Contact', route: null, icon: 'contacts', position: 2 },
      { id: 'portalNavOpportunities', label: 'Opportunities', entity: 'Opportunity', route: null, icon: 'fund', position: 3 },
      { id: 'portalNavTasks', label: 'Tasks', entity: 'Task', route: null, icon: 'check', position: 4 },
      { id: 'portalNavEmails', label: 'Emails', entity: 'Email', route: null, icon: 'mail', position: 5 },
      // SD.11 — customer self-service support cases.
      { id: 'portalNavCases', label: 'Support Cases', entity: 'Case', route: null, icon: 'customerService', position: 6 },
    ]) {
      await pool.query(
        `INSERT INTO portal_nav_items (id, portal_id, label, entity, route, icon, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [item.id, 'portalCustomer', item.label, item.entity, item.route, item.icon, item.position],
      );
    }
    await pool.query(
      `INSERT INTO portal_dashboards (id, portal_id, portal_role_id, name, layout, config, is_default)
       VALUES ($1, $2, NULL, $3, '[]'::jsonb, '{}'::jsonb, TRUE) ON CONFLICT (id) DO NOTHING`,
      ['portalCustomerDashboard', 'portalCustomer', 'Customer Portal'],
    );
    await pool.query(
      `INSERT INTO portal_dashlets (id, dashboard_id, name, kind, position, config)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [
        'portalDashletOpportunities',
        'portalCustomerDashboard',
        'Opportunities',
        'list',
        0,
        { entity: 'Opportunity', maxSize: 10, where: [] },
      ],
    );
    await pool.query(
      `INSERT INTO portal_dashlets (id, dashboard_id, name, kind, position, config)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [
        'portalDashletTasks',
        'portalCustomerDashboard',
        'Tasks',
        'kpi',
        1,
        { entity: 'Task', maxSize: 10, where: [] },
      ],
    );
    // SD.11 — the customer's most recent support cases, scoped by the portal ACL.
    await pool.query(
      `INSERT INTO portal_dashlets (id, dashboard_id, name, kind, position, config)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [
        'portalDashletCases',
        'portalCustomerDashboard',
        'Support Cases',
        'list',
        2,
        { entity: 'Case', maxSize: 10, where: [] },
      ],
    );

    // Phase 19 — default Project Board with its stage rows and the built-in project roles
    // (PLAN_Phase_19_Projects.md §14.1). Inserted once with fixed ids: re-running the seed never
    // duplicates them and never overwrites an administrator's edits.
    await seedProjectSystemRows(pool);

    // Phase 19-S — the document number series the Sales module allocates from
    // (PLAN_Phase_19_Sales.md §4.4). `ON CONFLICT (code) DO NOTHING`: a series keeps its counter,
    // prefix and padding once it exists, so re-running the seed can never reset a sequence.
    await seedSalesNumberSeries(pool);

    // Phase 19-CS.6.6 — the default onboarding playbook, installed once under a fixed id
    // (PLAN_Phase_19_Customer_Success.md §6.6).
    await seedCustomerSuccessSystemRows(pool);

    // Phase 19-S.17 — default DocumentTemplate rows for every Sales document type
    // (PLAN_Phase_19_Sales.md S.17 task 3). DocumentTemplate is an ordinary metadata entity stored
    // in `entity_records`; `ON CONFLICT (id) DO NOTHING`: an operator's edits survive a seed re-run.
    const insertTemplate = async (id: string, template: (typeof DEFAULT_DOCUMENT_TEMPLATES)[number]): Promise<void> => {
      await pool.query(
        `INSERT INTO entity_records (id, entity_type, name, attrs, created_at, modified_at, version)
         VALUES ($1, 'DocumentTemplate', $2, $3, now(), now(), 1) ON CONFLICT (id) DO NOTHING`,
        [id, template.name, JSON.stringify({
          code: template.code,
          targetEntity: template.targetEntity,
          subject: template.subject,
          body: template.body,
          format: template.format,
          locale: template.locale,
          active: template.active,
          isDefault: template.isDefault,
        })],
      );
    };
    for (const template of DEFAULT_DOCUMENT_TEMPLATES) {
      await insertTemplate(`tpl_${template.code}`, template);
    }

    await pool.query(
      `INSERT INTO teams (id, name) VALUES ($1, 'Sales') ON CONFLICT (id) DO NOTHING`,
      ['teamSales'],
    );

    // Never overwrite an existing admin password: shared dev database would break concurrent suites.
    await pool.query(
      `INSERT INTO users (id, user_name, is_admin, type, password, assigned_role_ids, first_name, last_name, email_address)
       VALUES ($1, $2, TRUE, 'admin', $3, '["sysAdmin"]', 'Admin', 'User', $4)
       ON CONFLICT (user_name) DO UPDATE SET is_active = TRUE, is_deleted = FALSE, is_admin = TRUE, type = 'admin'`,
      ['adminUserId', adminLogin, passwordHash, `${adminLogin}@example.com`],
    );
    if (options.resetAdminPassword) {
      await pool.query(`UPDATE users SET password = $2, is_admin = TRUE, type = 'admin' WHERE user_name = $1`, [adminLogin, passwordHash]);
    }

    if (options.demo) {
      const demoPassword = process.env.SEED_DEMO_PASSWORD ?? 'demo123';
      const demoHash = await argon2.hash(demoPassword, { type: argon2.argon2id });
      await pool.query(
        `INSERT INTO users (id, user_name, password, first_name, last_name, email_address, assigned_role_ids)
         VALUES ($1, 'demo', $2, 'Demo', 'User', 'demo@example.com', '["noAccess"]')
         ON CONFLICT (user_name) DO NOTHING`,
        ['demoUserId', demoHash],
      );
      await pool.query(`INSERT INTO users_teams (user_id, team_id) VALUES ('demoUserId', 'teamSales') ON CONFLICT DO NOTHING`);
    }

    // Activity reminders (PLAN §27): the worker scans due reminders on this schedule.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('scheduledReminders', 'system.sendReminders', '* * * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Chunked-upload housekeeping (PLAN §25): part files of abandoned uploads are removed hourly.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('cleanupUploads', 'system.cleanupUploads', '5 * * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Workflow run history (PLAN §35): finished runs are pruned monthly so it stays useful.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('cleanupWorkflowRuns', 'system.cleanupWorkflowRuns', '25 4 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Quote validity (PLAN_Phase_19_Sales.md 19-S.7): a quote whose valid-until date has passed is
    // expired once a day. The operation is idempotent, so a re-run or a retry changes nothing.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('expireQuotes', 'sales.expireQuotes', '20 1 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Invoice ageing (PLAN_Phase_19_Sales.md 19-S.9): an issued invoice past its due date is marked
    // overdue once a day, emitting one event per invoice. Idempotent, so a re-run emits nothing.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('markOverdueInvoices', 'sales.markOverdueInvoices', '35 1 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Subscription billing (Phase 19-S.16): due subscription periods are invoiced once a day. The
    // run is idempotent — a replay creates no duplicate period and no duplicate invoice — and it is
    // a no-op when the `subscriptions` feature is off.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('generateSubscriptionInvoices', 'sales.generateSubscriptionInvoices', '50 1 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Customer Success (Phase 19-CS.11): health is refreshed daily for profiles whose score is stale,
    // overrides that have passed their date are expired, and the portfolio scans run once a day. Each
    // operation is idempotent, so a replay changes nothing, and each is a no-op while the module's
    // feature flags are off.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('csRecalculateHealth', 'customerSuccess.recalculateHealthBatch', '10 2 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('csExpireHealthOverrides', 'customerSuccess.expireHealthOverrides', '25 2 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('csEvaluateRenewalWindows', 'customerSuccess.evaluateRenewalWindows', '40 2 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('csEvaluateRiskEscalations', 'customerSuccess.evaluateRiskEscalations', '50 2 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('csEvaluateReviewReminders', 'customerSuccess.evaluateReviewReminders', '5 3 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    // Lead Score decay sweep (PLAN_Phase_19_LeadScore.md §6.4, 19-LS.9): a score whose engagement signal
    // decays goes out of date with nobody editing the Lead, so the calendar asks for a bounded rebuild. The
    // schedule always exists; `settings.signals.decaySweep.enabled` decides whether the run does anything,
    // and the API answers `skipped: disabled` when it does not — so an operator turns one thing on.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('leadScoreDecaySweep', 'leadScore.decaySweep', '35 3 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    // Conversion recovery (PLAN_Phase_19_LeadScore.md §7.8, 19-LS.13): a conversion whose process died between
    // its claim and its work leaves a `processing` row nobody can answer. The schedule exists; the module's
    // `conversion.recovery.enabled` decides whether the run does anything, so an operator turns one thing on.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('leadScoreConvertRecovery', 'leadScore.recoverConversionOperations', '50 3 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('csUpdateGoalOverdue', 'customerSuccess.updateGoalOverdueState', '15 3 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('csProcessPlaybookWaitSteps', 'customerSuccess.processPlaybookWaitSteps', '25 3 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('csRepairStalePlaybookRuns', 'customerSuccess.repairStalePlaybookRuns', '35 3 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Service Desk (Phase 19-SD.9): SLA clocks are scanned for warnings, breaches and escalations
    // every five minutes. The pass is idempotent (fired thresholds and breach notifications are
    // recorded on the clock) and is a no-op while the `sla` feature is off.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('sdSlaScan', 'serviceDesk.slaScan', '*/5 * * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Marketing Automation (Phase 19-MA.9/MA.13): open delivery work is claimed every minute — the
    // cron recovery path when a queue-time delivery job was lost — and due journey steps advance every
    // two minutes. Both passes are idempotent by the ledger's claim and the enrollment's step locks,
    // and both are inert while the module's features are off.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('maDeliveryBatch', 'marketing.deliveryBatch', '* * * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('maJourneyRunBatch', 'marketing.journeyRunBatch', '*/2 * * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );

    // Advanced Integrations (Phase 19-INT.26): the retention purge runs once a day, off the hour so
    // it does not collide with the other sweeps. The purge is **off by default** — the API decides,
    // from the module's own policy, whether anything is removed — so the sweep is inert until a
    // deployment opts in.
    await pool.query(
      `INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled)
       VALUES ('aiPurgeRetention', 'advancedIntegrations.purgeRetention', '40 4 * * *', '{}'::jsonb, TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );

    for (const entry of coreMetadata) {
      await pool.query(
        `INSERT INTO metadata_entries (scope, name, data) VALUES ($1, $2, $3)
         ON CONFLICT (scope, name) DO UPDATE SET data = EXCLUDED.data, modified_at = now()`,
        [entry.scope, entry.name, JSON.stringify(entry.data)],
      );
    }

    await pool.query(
      `INSERT INTO app_settings (name, data) VALUES ('entity', $1) ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data`,
      [JSON.stringify(Object.fromEntries(coreMetadata.map((e) => [e.name, e.data])))],
    );
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  loadEnv();
  const demo = process.argv.includes('--demo');
  seed(getDatabaseUrl(), { demo })
    .then(() => {
      process.stdout.write('seed: done\n');
    })
    .catch((error: unknown) => {
      process.stderr.write(`seed failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
