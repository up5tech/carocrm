import { z } from 'zod';

/**
 * The action catalog (PLAN §35 "Actions").
 *
 * Every action is **data**: a name and a schema for its parameters. The engine never evaluates
 * anything an administrator typed beyond the sandboxed formula used by condition nodes, and the
 * implementations live behind a port, so the catalog here is the whole list of things automation can
 * do to an installation. Adding a capability means adding an entry *and* an implementation — there
 * is no path by which a definition can name code that the platform does not already provide.
 *
 * Parameter values may contain `{{field}}` placeholders, resolved against the triggering record at
 * execution time (`interpolate()`).
 */

const FieldMapSchema = z.record(z.string(), z.unknown());

export interface WorkflowActionSpec {
  /** Stable name stored in the definition; also what the admin UI offers. */
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** Parameters the engine understands. Unknown keys are rejected, so a typo fails loudly. */
  readonly params: z.ZodType<Record<string, unknown>>;
  /** True when the action changes CRM records (used by documentation and the UI, not enforced). */
  readonly mutatesRecords: boolean;
}

export const UPDATE_RECORD_PARAMS = z
  .object({ fields: FieldMapSchema })
  .strict() as unknown as z.ZodType<Record<string, unknown>>;

export const CREATE_RECORD_PARAMS = z
  .object({ entityType: z.string().min(1), fields: FieldMapSchema })
  .strict() as unknown as z.ZodType<Record<string, unknown>>;

export const CREATE_NOTIFICATION_PARAMS = z
  .object({
    userId: z.string().min(1),
    message: z.string().min(1).max(2000),
    data: FieldMapSchema.optional(),
  })
  .strict() as unknown as z.ZodType<Record<string, unknown>>;

export const SEND_EMAIL_PARAMS = z
  .object({
    to: z.string().min(1).max(2000),
    subject: z.string().min(1).max(998),
    body: z.string().max(20_000),
    cc: z.string().max(2000).optional(),
    bcc: z.string().max(2000).optional(),
  })
  .strict() as unknown as z.ZodType<Record<string, unknown>>;

export const RUN_JOB_PARAMS = z
  .object({ jobName: z.string().min(1), data: FieldMapSchema.optional() })
  .strict() as unknown as z.ZodType<Record<string, unknown>>;

const ENTITY_NAME = z.string().regex(/^[A-Z][A-Za-z0-9]{1,49}$/);
const FIELD_NAME = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,49}$/);
const OUTPUT_PATH = z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){0,7}$/).max(200);

/**
 * Phase 25.5 — one bounded AI step. The worker never builds a prompt or chooses a model: it names a
 * **published** agent, supplies the task text and optional record context, and asserts which pinned
 * skill keys it expects. The API re-checks all of that against the immutable version.
 *
 * `outputMapping` copies named values from a validated structured result onto the triggering record;
 * it is a field map, never an expression language. `approvalExpectation` cannot relax the agent's
 * approval policy — `must_require` only refuses an agent whose published policy never asks a human.
 */
export const RUN_AGENT_PARAMS = z
  .object({
    agentId: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
    task: z.string().min(1).max(4_000),
    record: z
      .object({ entity: ENTITY_NAME, id: z.string().min(1).max(120) })
      .strict()
      .optional(),
    skillKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(8).optional(),
    approvalExpectation: z.enum(['policy', 'must_require']).default('policy'),
    outputMapping: z
      .object({
        entity: ENTITY_NAME.optional(),
        recordId: z.string().min(1).max(120).optional(),
        fields: z.record(FIELD_NAME, OUTPUT_PATH).refine((fields) => Object.keys(fields).length > 0 && Object.keys(fields).length <= 12, {
          message: 'An output map needs between 1 and 12 fields.',
        }),
      })
      .strict()
      .optional(),
  })
  .strict() as unknown as z.ZodType<Record<string, unknown>>;

/** Longest delay a definition may request: a year is plenty for a CRM automation. */
export const MAX_DELAY_SECONDS = 365 * 24 * 60 * 60;

export const WORKFLOW_ACTIONS: readonly WorkflowActionSpec[] = [
  {
    name: 'updateRecord',
    label: 'Update the triggering record',
    description: 'Writes the given fields onto the record that started the workflow.',
    params: UPDATE_RECORD_PARAMS,
    mutatesRecords: true,
  },
  {
    name: 'createRecord',
    label: 'Create a record',
    description: 'Creates a record of the given entity type (Task, Opportunity, …).',
    params: CREATE_RECORD_PARAMS,
    mutatesRecords: true,
  },
  {
    name: 'createNotification',
    label: 'Notify a user',
    description: 'Writes an in-app notification to one user.',
    params: CREATE_NOTIFICATION_PARAMS,
    mutatesRecords: false,
  },
  {
    name: 'sendEmail',
    label: 'Send an email',
    description: 'Creates an Email record and queues it through the standard send job (§28).',
    params: SEND_EMAIL_PARAMS,
    mutatesRecords: true,
  },
  {
    name: 'runJob',
    label: 'Run a background job',
    description: 'Queues any registered job (§24), which is how extensions and integrations plug in.',
    params: RUN_JOB_PARAMS,
    mutatesRecords: false,
  },
  {
    name: 'runAgent',
    label: 'Run an AI agent',
    description:
      'Starts one published agent as the workflow initiator. The agent may use its granted write tools, and an optional output map writes validated result fields back to a record. Long runs park the workflow until the agent run settles.',
    params: RUN_AGENT_PARAMS,
    mutatesRecords: true,
  },
];

export const WORKFLOW_ACTION_NAMES: readonly string[] = WORKFLOW_ACTIONS.map((action) => action.name);

export function actionSpec(name: string): WorkflowActionSpec | undefined {
  return WORKFLOW_ACTIONS.find((action) => action.name === name);
}