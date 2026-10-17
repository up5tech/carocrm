/**
 * Phase 19-CS.6.6 — the module's default onboarding playbook
 * (PLAN_Phase_19_Customer_Success.md §6.6: "Seed default lifecycle/scoring/template records under
 * idempotent keys").
 *
 * The record itself lives in `entity_records` and is ordinary configuration: an administrator can
 * edit it, replace it or deactivate it. It is declared here, in a dependency-free module, so that
 * `database/seed.ts` can install it and `CustomerSuccessPlaybookService` can recognise it without
 * either of them importing the other.
 *
 * Preferring this id when a caller names no template makes the default path predictable: an
 * installation always runs *the* Default onboarding playbook unless a request names a template, and
 * an operator takes it over by editing this record or deactivating it (§5.5, admin guide).
 */
export const DEFAULT_ONBOARDING_TEMPLATE_ID = 'csTemplateOnboarding';

export interface DefaultPlaybookStep {
  readonly key: string;
  readonly name: string;
  readonly stepType: string;
  readonly order: number;
  readonly required: boolean;
  readonly dueOffsetDays?: number;
  readonly assigneePolicy: 'profileCsm' | 'accountOwner' | 'none';
  readonly dependsOn?: readonly string[];
  readonly instructions?: string;
}

export const DEFAULT_ONBOARDING_STEPS: readonly DefaultPlaybookStep[] = [
  {
    key: 'kickoff',
    name: 'Schedule the kickoff call',
    stepType: 'createTask',
    order: 0,
    required: true,
    dueOffsetDays: 3,
    assigneePolicy: 'profileCsm',
    instructions: 'Confirm stakeholders, success criteria and the escalation path.',
  },
  {
    key: 'stakeholders',
    name: 'Map the stakeholders',
    stepType: 'manual',
    order: 1,
    required: true,
    dueOffsetDays: 7,
    assigneePolicy: 'profileCsm',
    dependsOn: ['kickoff'],
    instructions: 'Record the sponsor, the daily owner and the people who can say no.',
  },
  {
    key: 'training',
    name: 'Complete administrator training',
    stepType: 'manual',
    order: 2,
    required: false,
    dueOffsetDays: 21,
    assigneePolicy: 'profileCsm',
    dependsOn: ['stakeholders'],
  },
  {
    key: 'valueReview',
    name: 'Review first value with the sponsor',
    stepType: 'createTask',
    order: 3,
    required: true,
    dueOffsetDays: 30,
    assigneePolicy: 'profileCsm',
    dependsOn: ['training'],
    instructions: 'Bring the adoption numbers and the first outcome the customer asked for.',
  },
  {
    key: 'handover',
    name: 'Hand over to the customer success cadence',
    stepType: 'notifyOwner',
    order: 4,
    required: false,
    assigneePolicy: 'profileCsm',
    dependsOn: ['valueReview'],
    instructions: 'Move the account to its regular success-review rhythm.',
  },
];

/** The `entity_records` row the seed installs for the default onboarding playbook. */
export const DEFAULT_ONBOARDING_TEMPLATE = {
  id: DEFAULT_ONBOARDING_TEMPLATE_ID,
  name: 'Default onboarding playbook',
  attrs: {
    description:
      'Seeded by the Customer Success module; edit it or replace it with your own onboarding playbook.',
    playbookType: 'onboarding',
    triggerMode: 'onboardingStarted',
    triggerConfig: {},
    isActive: true,
    version: 1,
    steps: JSON.stringify(DEFAULT_ONBOARDING_STEPS),
  },
} as const;
