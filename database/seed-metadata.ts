export interface MetadataSeedEntry {
  scope: 'entity' | 'settings';
  name: string;
  data: Record<string, unknown>;
}

const standardFields: Record<string, Record<string, unknown>> = {
  id: { type: 'varchar' },
  name: { type: 'varchar', maxLength: 255, inList: true, inDetail: true, inEdit: true, sortable: true, audited: true },
  description: { type: 'text', inDetail: true, inEdit: true },
  createdAt: { type: 'datetime', audited: true },
  modifiedAt: { type: 'datetime', audited: true },
  createdById: { type: 'link', entityKey: 'User' },
  modifiedById: { type: 'link', entityKey: 'User' },
  assignedUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true, inEdit: true, audited: true },
  teams: { type: 'linkMultiple', entityKey: 'Team' },
  deletedAt: { type: 'datetime' },
};

/**
 * Fields shared by the calendar activities (PLAN §27): Task, Call and Meeting.
 * Times are stored in UTC; the SPA renders them in the viewer's zone.
 */
const activityFields = (extra: Record<string, Record<string, unknown>> = {}): Record<string, Record<string, unknown>> => ({
  ...standardFields,
  name: { ...standardFields.name, required: true },
  status: { type: 'enum', values: ['Planned', 'Held', 'Not Held'], defaultValue: 'Planned', inList: true, inDetail: true, inEdit: true, audited: true },
  dateStart: { type: 'datetime', inList: true, inDetail: true, inEdit: true, sortable: true },
  dateEnd: { type: 'datetime', inList: true, inDetail: true, inEdit: true, sortable: true },
  duration: { type: 'int', inDetail: true, inEdit: true },
  isAllDay: { type: 'bool', inDetail: true, inEdit: true },
  description: standardFields['description'] ?? { type: 'text', inDetail: true, inEdit: true },
  reminder: { type: 'bool', inEdit: true },
  reminderTime: { type: 'int', defaultValue: 0, inEdit: true },
  reminderAt: { type: 'datetime' },
  reminderSentAt: { type: 'datetime' },
  repeatType: { type: 'enum', values: ['Daily', 'Weekly', 'Monthly', 'Yearly'], inDetail: true, inEdit: true },
  repeatEvery: { type: 'int', defaultValue: 1, inEdit: true },
  repeatEndDate: { type: 'date', inDetail: true, inEdit: true },
  repeatDayOfWeek: {
    type: 'multiEnum',
    values: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    inEdit: true,
  },
  repeatByMonth: { type: 'enum', values: ['Day of month', 'Day of week'], inEdit: true },
  ...extra,
});

/** Relations every activity exposes: related records plus participants and reminders. */
const activityRelations: Record<string, Record<string, unknown>> = {
  accounts: { type: 'manyMany', target: 'Account' },
  contacts: { type: 'manyMany', target: 'Contact' },
  users: { type: 'manyMany', target: 'User' },
  reminders: { type: 'manyMany', target: 'Reminder' },
};

/**
 * Relations of an Email (PLAN §28.3 "Related entity"). The same `entity_links` store the activities
 * use, so an email links to the records it concerns; its own attachments come from the §25
 * attachment table through `parentType: 'Email'`, not from a relation.
 */
const emailRelations: Record<string, Record<string, unknown>> = {
  accounts: { type: 'manyMany', target: 'Account' },
  contacts: { type: 'manyMany', target: 'Contact' },
  leads: { type: 'manyMany', target: 'Lead' },
  users: { type: 'manyMany', target: 'User' },
};

/**
 * Phase 19 — Projects (PLAN §19 / PLAN_Phase_19_Projects.md §5).
 *
 * Every Project record lives in the generic `entity_records` store like any other CRM entity, so
 * the Entity Engine provides CRUD, field validation, audit, stream, attachments and record ACL for
 * free. The relational invariants that JSON alone cannot express (unique membership, one dependency
 * edge, one stage key per board) are enforced by expression indexes in migration
 * `018_phase19_projects.sql`.
 */
const PROJECT_TASK_STATUSES = ['Not Started', 'Started', 'Completed', 'Canceled', 'Deferred'];
const PROJECT_GROUP_TYPES = ['Triage', 'Backlog', 'Work', 'Phase', 'Sprint'];
const PROJECT_DEPENDENCY_TYPES = ['FinishToStart', 'FinishToFinish', 'StartToStart', 'StartToFinish'];
const PROJECT_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

/** Standard fields shared by every Project entity, with the audit flags this module needs. */
const projectFields = (extra: Record<string, Record<string, unknown>> = {}): Record<string, Record<string, unknown>> => ({
  ...standardFields,
  name: { ...standardFields.name, required: true, audited: true },
  ...extra,
});

/**
 * Customer Success enum values (PLAN_Phase_19_Customer_Success.md §4). Declared **above**
 * `coreMetadata`, which is evaluated at module load and calls `customerSuccessEntities()`: a `const`
 * below it would still be in its temporal dead zone at that moment.
 */
const CS_LIFECYCLE_STAGES = ['onboarding', 'adoption', 'valueRealization', 'mature', 'renewal', 'atRisk', 'churned'];
const CS_HEALTH_STATUSES = ['healthy', 'monitor', 'atRisk', 'critical', 'unknown'];
const CS_HEALTH_OVERRIDES = ['healthy', 'monitor', 'atRisk', 'critical'];
const CS_TRENDS = ['improving', 'stable', 'declining', 'unknown'];
const CS_ONBOARDING_STATUSES = ['notStarted', 'inProgress', 'blocked', 'completed', 'canceled'];
const CS_RENEWAL_STATUSES = ['unknown', 'notDue', 'preparing', 'inProgress', 'renewed', 'atRisk', 'churned'];
const CS_PLAN_STATUSES = ['draft', 'active', 'onHold', 'completed', 'canceled'];
const CS_GOAL_DIRECTIONS = ['increase', 'decrease', 'maintain', 'boolean', 'manual'];
const CS_GOAL_STATUSES = ['notStarted', 'inProgress', 'achieved', 'missed', 'canceled', 'blocked'];
const CS_RISK_TYPES = ['adoption', 'engagement', 'support', 'stakeholder', 'valueRealization', 'renewal', 'commercial', 'implementation', 'competitor', 'unknown'];
const CS_RISK_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const CS_RISK_STATUSES = ['open', 'mitigating', 'escalated', 'resolved', 'accepted', 'closed'];
const CS_PLAYBOOK_TRIGGERS = ['manual', 'lifecycleTransition', 'healthTransition', 'renewalWindow', 'onboardingStarted'];
const CS_PLAYBOOK_STEP_TYPES = ['manual', 'createActivity', 'createTask', 'createRisk', 'createSuccessPlan', 'notifyOwner', 'waitUntil'];
const CS_RUN_STATUSES = ['pending', 'running', 'paused', 'completed', 'canceled', 'failed'];
const CS_STEP_RUN_STATUSES = ['pending', 'inProgress', 'completed', 'skipped', 'failed', 'canceled'];
const CS_SENTIMENTS = ['positive', 'neutral', 'negative', 'unknown'];
const CS_ACTIVITY_TYPES = ['Call', 'Meeting', 'Task', 'Email'];

/**
 * Phase 19-SD — Service Desk case vocabulary (PLAN_Phase_19_ServiceDesk.md §5.1, §5.2).
 *
 * Declared above `coreMetadata`, which is evaluated at module load and calls `serviceDeskCaseEntity()`.
 * The lists mirror `apps/api/src/service-desk/service-desk-domain.ts`; that module is the authority
 * for the server-side vocabulary, and the metadata health check catches any drift.
 */
const SD_CASE_STATUSES = ['New', 'Open', 'Pending Customer', 'Pending Internal', 'Escalated', 'Resolved', 'Closed', 'Cancelled'];
const SD_CASE_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
const SD_CASE_SEVERITIES = ['Low', 'Normal', 'High', 'Critical'];
const SD_CASE_TYPES = ['Question', 'Incident', 'Problem', 'Service Request'];
const SD_CASE_SOURCES = ['Web', 'Email', 'Portal', 'API', 'Web Form', 'Workflow', 'Phone'];
const SD_CASE_SLA_STATES = ['NotApplicable', 'OnTrack', 'Warning', 'Breached', 'Paused', 'Met'];
/** Division-of-labour vocabulary shared by queues and routing rules (SD.5, §5.3). */
const SD_ASSIGNMENT_STRATEGIES = ['manual', 'roundRobin', 'leastBusy'];
const SD_FALLBACK_BEHAVIORS = ['unassigned', 'fallbackOwner'];

export const coreMetadata: MetadataSeedEntry[] = [
  {
    scope: 'entity',
    name: 'Account',
    data: {
      name: 'Account',
      label: 'Account',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields.name, required: true },
        website: { type: 'url', inList: true, inDetail: true, inEdit: true },
        emailAddress: { type: 'email', inList: true, inDetail: true, inEdit: true },
        phoneNumber: { type: 'phone', inDetail: true, inEdit: true },
        type: { type: 'varchar', inList: true, inDetail: true, inEdit: true },
        industry: { type: 'varchar', inList: true, inDetail: true, inEdit: true },
        billingAddressStreet: { type: 'varchar', inDetail: true, inEdit: true },
        billingAddressCity: { type: 'varchar', inList: true, inDetail: true, inEdit: true },
        billingAddressCountry: { type: 'varchar', inDetail: true, inEdit: true },
      },
      relations: {
        contacts: { type: 'oneToMany', target: 'Contact', mappedBy: 'account' },
        opportunities: { type: 'oneToMany', target: 'Opportunity', mappedBy: 'account' },
        // Phase 19-S: the commercial documents that belong to this customer (§4.5 relationship panels).
        quotes: { type: 'oneToMany', target: 'Quote', mappedBy: 'account' },
        salesOrders: { type: 'oneToMany', target: 'SalesOrder', mappedBy: 'account' },
        invoices: { type: 'oneToMany', target: 'Invoice', mappedBy: 'account' },
        payments: { type: 'oneToMany', target: 'Payment', mappedBy: 'account' },
        subscriptions: { type: 'oneToMany', target: 'Subscription', mappedBy: 'accountId' },
        // Phase 19-SD: the support cases raised by this customer (§5.1 customer relations).
        cases: { type: 'oneToMany', target: 'Case', mappedBy: 'account' },
      },
      indexes: [],
      record: { displayField: 'name', removable: true },
      client: {},
    },
  },
  {
    scope: 'entity',
    name: 'Contact',
    data: {
      name: 'Contact',
      label: 'Contact',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields.name, required: true },
        firstName: { type: 'varchar', maxLength: 128, inList: true, inDetail: true, inEdit: true },
        lastName: { type: 'varchar', required: true, maxLength: 128, inList: true, inDetail: true, inEdit: true },
        title: { type: 'varchar', inList: true, inDetail: true, inEdit: true },
        emailAddress: { type: 'email', inList: true, inDetail: true, inEdit: true },
        phoneNumber: { type: 'phone', inDetail: true, inEdit: true },
        accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true, inEdit: true },
        leadSource: { type: 'varchar', inDetail: true, inEdit: true },
        status: { type: 'enum', values: ['Active', 'Left'], defaultValue: 'Active', inList: true, inDetail: true, inEdit: true },
      },
      relations: {
        // Phase 19-SD: the support cases this contact is the requester of.
        cases: { type: 'oneToMany', target: 'Case', mappedBy: 'contact' },
      },
      indexes: [],
      record: { displayField: 'lastName', removable: true },
      client: {},
    },
  },
  {
    scope: 'entity',
    name: 'Lead',
    data: {
      name: 'Lead',
      label: 'Lead',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields.name, required: true },
        firstName: { type: 'varchar', maxLength: 128, inList: true, inDetail: true, inEdit: true },
        lastName: { type: 'varchar', required: true, maxLength: 128, inList: true, inDetail: true, inEdit: true },
        title: { type: 'varchar', inDetail: true, inEdit: true },
        emailAddress: { type: 'email', inList: true, inDetail: true, inEdit: true },
        phoneNumber: { type: 'phone', inDetail: true, inEdit: true },
        company: { type: 'varchar', inList: true, inDetail: true, inEdit: true },
        industry: { type: 'varchar', inDetail: true, inEdit: true },
        source: { type: 'varchar', inList: true, inDetail: true, inEdit: true },
        status: {
          type: 'enum',
          values: ['New', 'Assigned', 'In Process', 'Converted', 'Dead'],
          defaultValue: 'New',
          inList: true,
          inDetail: true,
          inEdit: true,
        },
      },
      relations: {},
      indexes: [],
      record: { displayField: 'lastName', removable: true },
      client: {},
    },
  },
  {
    scope: 'entity',
    name: 'Opportunity',
    data: {
      name: 'Opportunity',
      label: 'Opportunity',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields.name, required: true },
        amount: { type: 'currency', inList: true, inDetail: true, inEdit: true },
        closeDate: { type: 'date', inList: true, inDetail: true, inEdit: true },
        stage: {
          type: 'enum',
          values: ['Qualification', 'Analysis', 'Proposal', 'Price Negotiation', 'Review', 'Closed Won', 'Closed Lost'],
          defaultValue: 'Qualification',
          inList: true,
          inDetail: true,
          inEdit: true,
        },
        probability: { type: 'int', inList: true, inDetail: true, inEdit: true },
        nextStep: { type: 'varchar', inDetail: true, inEdit: true },
        type: { type: 'varchar', inDetail: true, inEdit: true },
        leadSource: { type: 'varchar', inDetail: true, inEdit: true },
        accountId: { type: 'link', entityKey: 'Account', inDetail: true, inEdit: true },
        contactIds: { type: 'linkMultiple', entityKey: 'Contact', inDetail: true, inEdit: true },
      },
      relations: {
        // Phase 19-S.7: the quotes raised against this deal, so an Opportunity shows the commercial
        // documents it produced. `mappedBy` resolves through `opportunityId` on Quote.
        quotes: { type: 'oneToMany', target: 'Quote', mappedBy: 'opportunity' },
      },
      indexes: [],
      record: { displayField: 'name', removable: true },
      client: {},
    },
  },
  {
    scope: 'entity',
    name: 'Task',
    data: {
      name: 'Task',
      label: 'Task',
      isEntity: true,
      fields: activityFields({
        status: {
          type: 'enum',
          values: ['Not Started', 'Started', 'Completed', 'Canceled', 'Deferred'],
          defaultValue: 'Not Started',
          inList: true,
          inDetail: true,
          inEdit: true,
          audited: true,
        },
        priority: {
          type: 'enum',
          values: ['Low', 'Normal', 'High', 'Urgent'],
          defaultValue: 'Normal',
          inList: true,
          inDetail: true,
          inEdit: true,
        },
        dateCompleted: { type: 'datetime', inDetail: true },
      }),
      relations: activityRelations,
      indexes: [],
      record: { displayField: 'name', removable: true },
      client: {},
    },
  },
  {
    scope: 'entity',
    name: 'Call',
    data: {
      name: 'Call',
      label: 'Call',
      isEntity: true,
      fields: activityFields({
        direction: { type: 'enum', values: ['Internal', 'Outbound', 'Inbound'], defaultValue: 'Internal', inList: true, inDetail: true, inEdit: true },
      }),
      relations: activityRelations,
      indexes: [],
      record: { displayField: 'name', removable: true },
      client: {},
    },
  },
  {
    scope: 'entity',
    name: 'Meeting',
    data: {
      name: 'Meeting',
      label: 'Meeting',
      isEntity: true,
      fields: activityFields({
        acceptanceStatus: {
          type: 'enum',
          values: ['None', 'Accepted', 'Tentative', 'Declined'],
          defaultValue: 'None',
          inDetail: true,
          inEdit: true,
        },
      }),
      relations: activityRelations,
      indexes: [],
      record: { displayField: 'name', removable: true },
      client: {},
    },
  },
  {
    scope: 'entity',
    name: 'Reminder',
    data: {
      name: 'Reminder',
      label: 'Reminder',
      isEntity: true,
      fields: {
        ...standardFields,
        type: { type: 'enum', values: ['Popup', 'Email'], defaultValue: 'Popup', inList: true, inDetail: true, inEdit: true },
        before: { type: 'int', defaultValue: 0, inDetail: true, inEdit: true },
        timeUnit: { type: 'enum', values: ['minutes', 'hours', 'days'], defaultValue: 'minutes', inDetail: true, inEdit: true },
        attribute: { type: 'varchar', inDetail: true, inEdit: true },
        remindAt: { type: 'datetime', inList: true, inDetail: true, sortable: true },
        isActivity: { type: 'bool', defaultValue: true, inDetail: true },
        isActive: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        minutes: { type: 'int', inDetail: true },
      },
      relations: {},
      indexes: [],
      record: { displayField: 'type', removable: true },
      client: { web: false },
    },
  },
  {
    scope: 'entity',
    name: 'Email',
    data: {
      name: 'Email',
      label: 'Email',
      isEntity: true,
      fields: {
        ...standardFields,
        // The record's display name IS the subject (PLAN §28.3), so lists and search show what a
        // reader recognises from their inbox.
        name: { ...standardFields.name, label: 'Subject', required: true, maxLength: 998, audited: true },
        status: {
          type: 'enum',
          values: ['Draft', 'Queued', 'Sending', 'Sent', 'Failed', 'Inbound'],
          defaultValue: 'Draft',
          inList: true,
          inDetail: true,
          inEdit: true,
          audited: true,
        },
        direction: { type: 'enum', values: ['Outbound', 'Inbound'], defaultValue: 'Outbound', inList: true, inDetail: true },
        /** Sending mailbox (PLAN Phase 11 "Email accounts"); empty = the configured default transport. */
        emailAccountId: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
        /** Template applied when the send is queued (PLAN Phase 11 "Email templates"). */
        templateId: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
        fromAddress: { type: 'varchar', maxLength: 512, inList: true, inDetail: true, inEdit: true },
        toAddressList: { type: 'varchar', maxLength: 4000, label: 'To', inList: true, inDetail: true, inEdit: true },
        ccAddressList: { type: 'varchar', maxLength: 4000, label: 'Cc', inDetail: true, inEdit: true },
        bccAddressList: { type: 'varchar', maxLength: 4000, label: 'Bcc', inDetail: true, inEdit: true },
        replyToAddress: { type: 'varchar', maxLength: 512, label: 'Reply-to', inDetail: true, inEdit: true },
        body: { type: 'text', label: 'Body', inDetail: true, inEdit: true },
        bodyHtml: { type: 'text', label: 'Html Body', inDetail: true, inEdit: true },
        headers: { type: 'text', label: 'Headers (JSON)', inDetail: true },
        messageId: { type: 'varchar', maxLength: 512, inDetail: true },
        threadId: { type: 'varchar', maxLength: 512, inDetail: true },
        inReplyTo: { type: 'varchar', maxLength: 512, inDetail: true },
        dateSent: { type: 'datetime', inList: true, inDetail: true, sortable: true },
        deliveryError: { type: 'text', label: 'Delivery error', inDetail: true },
        parentType: { type: 'varchar', maxLength: 64, inDetail: true },
        parentId: { type: 'varchar', maxLength: 64, inDetail: true },
      },
      relations: emailRelations,
      indexes: [{ name: 'idx_email_message_id', fields: ['messageId'] }, { name: 'idx_email_thread_id', fields: ['threadId'] }],
      record: { displayField: 'name', removable: true },
      client: {},
    },
  },
  {
    scope: 'entity',
    name: 'EmailTemplate',
    data: {
      name: 'EmailTemplate',
      label: 'Email Template',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields.name, label: 'Name', required: true },
        subject: { type: 'varchar', maxLength: 998, required: true, inList: true, inDetail: true, inEdit: true, audited: true },
        body: { type: 'text', label: 'Body', inDetail: true, inEdit: true },
        bodyHtml: { type: 'text', label: 'Html Body', inDetail: true, inEdit: true },
        /** Comma-separated categories for the picker; free text, no enum. */
        category: { type: 'varchar', maxLength: 100, inList: true, inDetail: true, inEdit: true },
      },
      relations: {},
      indexes: [],
      record: { displayField: 'name', removable: true },
      client: {},
    },
  },
  // ---------------------------------------------------------------------------
  // Phase 19 — Projects
  // ---------------------------------------------------------------------------
  {
    scope: 'entity',
    name: 'Project',
    data: {
      name: 'Project',
      label: 'Project',
      isEntity: true,
      fields: projectFields({
        description: { type: 'text', inDetail: true, inEdit: true },
        dateStart: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true, audited: true },
        dateEnd: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true, audited: true },
        /** Accountable owner (PLAN §4.1) — distinct from `assignedUserId`, the CRM record owner. */
        ownerUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true, inEdit: true, audited: true },
        /** Immutable after creation (PLAN §4.1): enforced by the Projects domain hook. */
        boardId: { type: 'link', entityKey: 'ProjectBoard', required: true, inList: true, inDetail: true, inEdit: true },
        categoryId: { type: 'link', entityKey: 'ProjectCategory', inList: true, inDetail: true, inEdit: true },
        activeGroupId: { type: 'link', entityKey: 'ProjectGroup', inDetail: true, inEdit: true },
        // Project-level feature settings (PLAN §4.11). Disabling hides the control and the backend
        // rejects writes; the stored values themselves are never erased.
        dependenciesEnabled: { type: 'bool', defaultValue: false, inDetail: true, inEdit: true },
        collaboratorsEnabled: { type: 'bool', defaultValue: false, inDetail: true, inEdit: true },
        priorityEnabled: { type: 'bool', defaultValue: true, inDetail: true, inEdit: true },
        pointsEnabled: { type: 'bool', defaultValue: false, inDetail: true, inEdit: true },
        estimatedHoursEnabled: { type: 'bool', defaultValue: false, inDetail: true, inEdit: true },
        ganttEnabled: { type: 'bool', defaultValue: true, inDetail: true, inEdit: true },
      }),
      relations: {
        members: { type: 'oneToMany', target: 'ProjectMember', mappedBy: 'project' },
        groups: { type: 'oneToMany', target: 'ProjectGroup', mappedBy: 'project' },
        tasks: { type: 'oneToMany', target: 'ProjectTask', mappedBy: 'project' },
        accounts: { type: 'manyMany', target: 'Account' },
        contacts: { type: 'manyMany', target: 'Contact' },
        meetings: { type: 'manyMany', target: 'Meeting' },
        calls: { type: 'manyMany', target: 'Call' },
        emails: { type: 'manyMany', target: 'Email' },
      },
      indexes: [{ name: 'idx_project_board', fields: ['boardId'] }, { name: 'idx_project_category', fields: ['categoryId'] }],
      layouts: {
        list: [{ entity: 'Project', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'dateStart', 'dateEnd', 'ownerUserId', 'categoryId', 'boardId', 'modifiedAt'] }] }],
        detail: [
          {
            entity: 'Project',
            type: 'detail',
            panels: [
              { name: 'overview', label: 'Overview', position: 0, fields: ['name', 'description', 'dateStart', 'dateEnd'] },
              { name: 'structure', label: 'Board and category', position: 10, fields: ['boardId', 'categoryId', 'ownerUserId', 'activeGroupId', 'assignedUserId', 'teams'] },
              { name: 'settings', label: 'Settings', position: 20, fields: ['dependenciesEnabled', 'collaboratorsEnabled', 'priorityEnabled', 'pointsEnabled', 'estimatedHoursEnabled', 'ganttEnabled'] },
            ],
          },
        ],
        edit: [
          {
            entity: 'Project',
            type: 'edit',
            panels: [
              { name: 'main', label: 'Project', position: 0, fields: ['name', 'description', 'dateStart', 'dateEnd', 'boardId', 'categoryId'] },
              { name: 'ownership', label: 'Ownership', position: 10, fields: ['ownerUserId', 'assignedUserId', 'teams'] },
            ],
          },
        ],
      },
      record: { displayField: 'name', removable: true, followable: true, streamable: true },
      client: {},
      acl: {
        permissions: { Project: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } },
      },
    },
  },
  {
    scope: 'entity',
    name: 'ProjectCategory',
    data: {
      name: 'ProjectCategory',
      label: 'Project Category',
      isEntity: true,
      fields: projectFields({
        description: { type: 'text', inDetail: true, inEdit: true },
        parentId: { type: 'link', entityKey: 'ProjectCategory', inList: true, inDetail: true, inEdit: true },
        sortOrder: { type: 'int', defaultValue: 0, inList: true, inDetail: true, inEdit: true, sortable: true },
      }),
      relations: {
        childCategories: { type: 'oneToMany', target: 'ProjectCategory', mappedBy: 'parent' },
        projects: { type: 'oneToMany', target: 'Project', mappedBy: 'category' },
      },
      indexes: [{ name: 'idx_project_category_parent', fields: ['parentId'] }],
      layouts: {
        list: [{ entity: 'ProjectCategory', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'parentId', 'sortOrder'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
      acl: { permissions: { ProjectCategory: { create: 'yes', read: 'all', edit: 'all', delete: 'all', stream: 'no' } } },
    },
  },
  {
    scope: 'entity',
    name: 'ProjectBoard',
    data: {
      name: 'ProjectBoard',
      label: 'Project Board',
      isEntity: true,
      fields: projectFields({
        description: { type: 'text', inDetail: true, inEdit: true },
        /** Deterministic fallback board for projects created without an explicit board. */
        isDefault: { type: 'bool', defaultValue: false, inList: true, inDetail: true, inEdit: true },
      }),
      relations: {
        stages: { type: 'oneToMany', target: 'ProjectBoardStage', mappedBy: 'board' },
        projects: { type: 'oneToMany', target: 'Project', mappedBy: 'board' },
      },
      indexes: [],
      layouts: {
        list: [{ entity: 'ProjectBoard', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'isDefault', 'modifiedAt'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
      acl: { permissions: { ProjectBoard: { create: 'yes', read: 'all', edit: 'all', delete: 'all', stream: 'no' } } },
    },
  },
  {
    scope: 'entity',
    name: 'ProjectBoardStage',
    data: {
      name: 'ProjectBoardStage',
      label: 'Project Board Stage',
      isEntity: true,
      fields: projectFields({
        boardId: { type: 'link', entityKey: 'ProjectBoard', required: true, inList: true, inDetail: true, inEdit: true },
        /** Stable internal key; renaming the display `name` must never break task references. */
        key: { type: 'varchar', maxLength: 64, required: true, inList: true, inDetail: true, inEdit: true },
        sortOrder: { type: 'int', defaultValue: 0, inList: true, inDetail: true, inEdit: true, sortable: true },
        statusValue: { type: 'enum', values: PROJECT_TASK_STATUSES, defaultValue: 'Not Started', required: true, inList: true, inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_project_board_stage_board', fields: ['boardId'] }],
      layouts: {
        list: [{ entity: 'ProjectBoardStage', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'key', 'statusValue', 'sortOrder'] }] }],
      },
      record: { displayField: 'name', removable: true },
      // Managed as part of its board (PLAN §4.3); not a navigation target of its own.
      client: { web: false },
    },
  },
  {
    scope: 'entity',
    name: 'ProjectRole',
    data: {
      name: 'ProjectRole',
      label: 'Project Role',
      isEntity: true,
      fields: projectFields({
        description: { type: 'text', inDetail: true, inEdit: true },
        /** Built-in Owner/Editor/Member rows: never deletable and their scope fields stay editable only by an admin. */
        isSystem: { type: 'bool', defaultValue: false, inList: true, inDetail: true },
        taskCreate: { type: 'enum', values: ['yes', 'no'], defaultValue: 'yes', inList: true, inDetail: true, inEdit: true },
        assignmentScope: { type: 'enum', values: ['all', 'own'], defaultValue: 'all', inDetail: true, inEdit: true },
        taskReadScope: { type: 'enum', values: ['all', 'own'], defaultValue: 'all', inDetail: true, inEdit: true },
        taskStreamScope: { type: 'enum', values: ['all', 'own'], defaultValue: 'all', inDetail: true, inEdit: true },
        taskEditScope: { type: 'enum', values: ['all', 'assigned', 'own'], defaultValue: 'all', inList: true, inDetail: true, inEdit: true },
        stageMoveScope: { type: 'enum', values: ['all', 'assigned', 'own'], defaultValue: 'all', inList: true, inDetail: true, inEdit: true },
        taskDeleteScope: { type: 'enum', values: ['all', 'own', 'no'], defaultValue: 'own', inDetail: true, inEdit: true },
        projectStreamAccess: { type: 'enum', values: ['yes', 'no'], defaultValue: 'yes', inDetail: true, inEdit: true },
        groupManage: { type: 'enum', values: ['yes', 'no'], defaultValue: 'no', inDetail: true, inEdit: true },
        memberManage: { type: 'enum', values: ['yes', 'no'], defaultValue: 'no', inDetail: true, inEdit: true },
        projectEdit: { type: 'enum', values: ['yes', 'no'], defaultValue: 'no', inDetail: true, inEdit: true },
      }),
      relations: { members: { type: 'oneToMany', target: 'ProjectMember', mappedBy: 'projectRole' } },
      indexes: [],
      layouts: {
        list: [{ entity: 'ProjectRole', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'taskEditScope', 'stageMoveScope', 'isSystem'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
      acl: { permissions: { ProjectRole: { create: 'yes', read: 'all', edit: 'all', delete: 'all', stream: 'no' } } },
    },
  },
  {
    scope: 'entity',
    name: 'ProjectMember',
    data: {
      name: 'ProjectMember',
      label: 'Project Member',
      isEntity: true,
      fields: projectFields({
        projectId: { type: 'link', entityKey: 'Project', required: true, inList: true, inDetail: true, inEdit: true },
        userId: { type: 'link', entityKey: 'User', required: true, inList: true, inDetail: true, inEdit: true },
        projectRoleId: { type: 'link', entityKey: 'ProjectRole', required: true, inList: true, inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_project_member_project', fields: ['projectId'] }, { name: 'idx_project_member_user', fields: ['userId'] }],
      record: { displayField: 'name', removable: true },
      client: { web: false },
    },
  },
  {
    scope: 'entity',
    name: 'ProjectGroup',
    data: {
      name: 'ProjectGroup',
      label: 'Project Group',
      isEntity: true,
      fields: projectFields({
        projectId: { type: 'link', entityKey: 'Project', required: true, inList: true, inDetail: true, inEdit: true },
        groupType: { type: 'enum', values: PROJECT_GROUP_TYPES, defaultValue: 'Work', required: true, inList: true, inDetail: true, inEdit: true, audited: true },
        sortOrder: { type: 'int', defaultValue: 0, inList: true, inDetail: true, sortable: true },
        color: { type: 'varchar', maxLength: 32, inDetail: true, inEdit: true },
        newTaskPlacement: { type: 'enum', values: ['Top', 'Bottom'], defaultValue: 'Bottom', inDetail: true, inEdit: true },
      }),
      relations: {
        tasks: { type: 'oneToMany', target: 'ProjectTask', mappedBy: 'group' },
      },
      indexes: [{ name: 'idx_project_group_project', fields: ['projectId', 'sortOrder'] }],
      record: { displayField: 'name', removable: true },
      client: { web: false },
    },
  },
  {
    scope: 'entity',
    name: 'ProjectTask',
    data: {
      name: 'ProjectTask',
      label: 'Project Task',
      isEntity: true,
      fields: projectFields({
        description: { type: 'text', inDetail: true, inEdit: true },
        projectId: { type: 'link', entityKey: 'Project', required: true, inList: true, inDetail: true, inEdit: true },
        groupId: { type: 'link', entityKey: 'ProjectGroup', inList: true, inDetail: true, inEdit: true, audited: true },
        parentTaskId: { type: 'link', entityKey: 'ProjectTask', inDetail: true, inEdit: true },
        taskType: { type: 'enum', values: ['Task', 'Milestone'], defaultValue: 'Task', inList: true, inDetail: true, inEdit: true },
        stageId: { type: 'link', entityKey: 'ProjectBoardStage', inList: true, inDetail: true, inEdit: true, audited: true },
        /** Derived from the board stage mapping; never written through generic CRUD (PLAN §4.3). */
        status: { type: 'enum', values: PROJECT_TASK_STATUSES, defaultValue: 'Not Started', inList: true, inDetail: true, sortable: true, audited: true },
        ownerUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true, inEdit: true, audited: true },
        assigneeUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true, inEdit: true, audited: true },
        dateStart: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true, audited: true },
        dateEnd: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true, audited: true },
        priority: { type: 'enum', values: PROJECT_PRIORITIES, defaultValue: 'Normal', inList: true, inDetail: true, inEdit: true, audited: true },
        points: { type: 'int', inDetail: true, inEdit: true },
        estimateHours: { type: 'float', inDetail: true, inEdit: true },
        sortOrder: { type: 'int', defaultValue: 0, inDetail: true, sortable: true },
      }),
      relations: {
        subtasks: { type: 'oneToMany', target: 'ProjectTask', mappedBy: 'parentTask' },
        collaborators: { type: 'oneToMany', target: 'ProjectTaskCollaborator', mappedBy: 'task' },
        dependencies: { type: 'oneToMany', target: 'ProjectTaskDependency', mappedBy: 'task' },
      },
      indexes: [
        { name: 'idx_project_task_project_group', fields: ['projectId', 'groupId', 'sortOrder'] },
        { name: 'idx_project_task_stage', fields: ['stageId'] },
        { name: 'idx_project_task_assignee', fields: ['assigneeUserId'] },
        { name: 'idx_project_task_dates', fields: ['dateStart', 'dateEnd'] },
      ],
      layouts: {
        list: [{ entity: 'ProjectTask', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'status', 'projectId', 'groupId', 'assigneeUserId', 'dateStart', 'dateEnd', 'priority'] }] }],
        detail: [
          {
            entity: 'ProjectTask',
            type: 'detail',
            panels: [
              { name: 'overview', label: 'Overview', position: 0, fields: ['name', 'description', 'taskType', 'status', 'stageId', 'projectId', 'groupId', 'parentTaskId'] },
              { name: 'people', label: 'People', position: 10, fields: ['ownerUserId', 'assigneeUserId', 'assignedUserId'] },
              { name: 'planning', label: 'Planning', position: 20, fields: ['dateStart', 'dateEnd', 'priority', 'points', 'estimateHours'] },
            ],
          },
        ],
        edit: [
          {
            entity: 'ProjectTask',
            type: 'edit',
            panels: [
              { name: 'main', label: 'Task', position: 0, fields: ['name', 'description', 'taskType', 'projectId', 'groupId', 'parentTaskId'] },
              { name: 'planning', label: 'Planning', position: 10, fields: ['ownerUserId', 'assigneeUserId', 'dateStart', 'dateEnd', 'priority', 'points', 'estimateHours'] },
            ],
          },
        ],
      },
      record: { displayField: 'name', removable: true, followable: true, streamable: true },
      client: {},
      acl: { permissions: { ProjectTask: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } } },
    },
  },
  {
    scope: 'entity',
    name: 'ProjectTaskCollaborator',
    data: {
      name: 'ProjectTaskCollaborator',
      label: 'Project Task Collaborator',
      isEntity: true,
      fields: projectFields({
        taskId: { type: 'link', entityKey: 'ProjectTask', required: true, inList: true, inDetail: true, inEdit: true },
        userId: { type: 'link', entityKey: 'User', required: true, inList: true, inDetail: true, inEdit: true },
        projectId: { type: 'link', entityKey: 'Project', inList: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_project_task_collaborator_task', fields: ['taskId'] }, { name: 'idx_project_task_collaborator_user', fields: ['userId'] }],
      record: { displayField: 'name', removable: true },
      client: { web: false },
    },
  },
  {
    scope: 'entity',
    name: 'ProjectTaskDependency',
    data: {
      name: 'ProjectTaskDependency',
      label: 'Project Task Dependency',
      isEntity: true,
      // `taskId` is the successor, `predecessorTaskId` the dependency it waits for (PLAN §4.8).
      fields: projectFields({
        taskId: { type: 'link', entityKey: 'ProjectTask', required: true, inList: true, inDetail: true, inEdit: true },
        predecessorTaskId: { type: 'link', entityKey: 'ProjectTask', required: true, inList: true, inDetail: true, inEdit: true },
        projectId: { type: 'link', entityKey: 'Project', required: true, inList: true },
        dependencyType: { type: 'enum', values: PROJECT_DEPENDENCY_TYPES, inList: true, inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_project_task_dependency_task', fields: ['taskId'] }, { name: 'idx_project_task_dependency_predecessor', fields: ['predecessorTaskId'] }],
      record: { displayField: 'name', removable: true },
      client: { web: false },
    },
  },

  // -------------------------------------------------------------------------
  // Phase 19-S — Sales & Commercial Operations (`sales`)
  // -------------------------------------------------------------------------
  //
  // The catalog, pricing and tax entities (PLAN_Phase_19_Sales.md §5.1, §5.4). They are ordinary
  // metadata entities in `entity_records`, served by the generic API/Entity Engine like every other
  // record; the Sales module adds the cross-record rules in `apps/api/src/sales` and the expression
  // indexes in `database/migrations/021_phase19_sales.sql`.
  //
  // Money and quantities use the `currency` field type: it is the platform's only field type that
  // stores a **canonical decimal string** and is cast to `numeric` by the query/report engine, so
  // amounts never become binary floating point on their way through the API (audit §5).
  salesProductEntity(),
  salesProductCategoryEntity(),
  salesPriceBookEntity(),
  salesPriceBookEntryEntity(),
  salesPriceRuleEntity(),
  salesSupplierEntity(),
  salesSupplierPriceEntity(),
  salesTaxClassEntity(),
  salesTaxCodeEntity(),
  salesTaxRateEntity(),
  salesTaxRuleEntity(),

  // -------------------------------------------------------------------------
  // Phase 19-S.6 – 19-S.12 — commercial documents and their line items (`sales`)
  // -------------------------------------------------------------------------
  //
  // A document and its items are ordinary metadata entities, exactly like the catalog records above:
  // the Entity Engine keeps CRUD, validation, field ACL, audit, stream and search, and the Sales
  // module adds the state machine, numbering, issuance snapshot and locking in
  // `apps/api/src/sales/document`. Items are real records rather than one opaque JSON blob, so
  // item-level filtering, reporting and custom fields keep working (PLAN_Phase_19_Sales.md §4.4).
  //
  // The state lists here mirror `apps/api/src/sales/document/descriptors.ts`; the descriptor is the
  // authority, and a drift between the two is caught by the metadata health check.
  salesQuoteEntity(),
  salesQuoteItemEntity(),
  salesSalesOrderEntity(),
  salesSalesOrderItemEntity(),
  salesInvoiceEntity(),
  salesInvoiceItemEntity(),
  salesCreditNoteEntity(),
  salesCreditNoteItemEntity(),
  salesDeliveryOrderEntity(),
  salesDeliveryOrderItemEntity(),
  salesReturnOrderEntity(),
  salesReturnOrderItemEntity(),
  salesPaymentTermProfileEntity(),

  // -----------------------------------------------------------------------
  // Phase 19-S.13 — purchasing (`sales`)
  // -----------------------------------------------------------------------
  salesPurchaseOrderEntity(),
  salesPurchaseOrderItemEntity(),
  salesReceiptOrderEntity(),
  salesReceiptOrderItemEntity(),
  salesBillEntity(),
  salesBillItemEntity(),
  salesBillCreditEntity(),
  salesBillCreditItemEntity(),
  salesBillCreditAllocationEntity(),

  // -----------------------------------------------------------------------
  // Phase 19-S.14 — inventory (`sales`)
  // -----------------------------------------------------------------------
  //
  // Warehouses, the append-only movement ledger, reviewed adjustments, controlled transfers and the
  // reservations an order places (PLAN_Phase_19_Sales.md §4.15, §5.5). The state lists here mirror
  // `apps/api/src/sales/inventory/ledger.ts`; that module is the authority.
  salesWarehouseEntity(),
  salesInventoryTransactionEntity(),
  salesInventoryAdjustmentEntity(),
  salesTransferOrderEntity(),
  salesTransferOrderItemEntity(),
  salesInventoryReservationEntity(),

  // -----------------------------------------------------------------------
  // Phase 19-S.15 — batch/serial stock identity (`sales`)
  // -----------------------------------------------------------------------
  //
  // The lot and unit records a removal policy picks from (PLAN_Phase_19_Sales.md §4.15, §5.5).
  // Their quantities live in `sales_inventory_batch_stock` (migration 029) and in the serials'
  // own `status`, both maintained only by the inventory service — the record API may create a lot's
  // metadata and correct its dates, but never its identity or a unit's state.
  salesInventoryBatchEntity(),
  salesInventorySerialEntity(),

  // -------------------------------------------------------------------------
  // Phase 19-S.16 — subscriptions (`sales`)
  // -------------------------------------------------------------------------
  salesSubscriptionEntity(),
  salesSubscriptionPeriodEntity(),

  // -------------------------------------------------------------------------
  // Phase 19-S.10 – 19-S.11 — payments, allocations, corrections (`sales`)
  // -------------------------------------------------------------------------
  //
  // A payment is a recorded financial event, not a gateway object: amount, currency, direction, date,
  // method, counterparty, reference. Everything provider-specific lives in a provider module, and this
  // module's contract with it is a provider-neutral payment request plus an idempotent event log keyed
  // by the provider's own event id (PLAN_Phase_19_Sales.md §4.8).
  salesPaymentMethodEntity(),
  salesPaymentChannelEntity(),
  salesPaymentEntity(),
  salesPaymentAllocationEntity(),
  salesPaymentTransferAllocationEntity(),
  salesPaymentRequestEntity(),
  salesPaymentProviderEventLogEntity(),
  salesCreditNoteAllocationEntity(),
  salesWriteOffEntity(),

  // -------------------------------------------------------------------------
  // Phase 19 — the `document` module (kernel): a template is a record like any other
  // -------------------------------------------------------------------------
  coreDocumentTemplateEntity(),

  // -------------------------------------------------------------------------
  // Phase 19-CS — Customer Success (PLAN_Phase_19_Customer_Success.md §6)
  // -------------------------------------------------------------------------
  ...customerSuccessEntities(),

  // -------------------------------------------------------------------------
  // Phase 19-SD — Service Desk (`ServiceDesk`): the canonical support-case entity
  // -------------------------------------------------------------------------
  //
  // `Case` is the single ticket entity (PLAN_Phase_19_ServiceDesk.md §5.1). It is an ordinary
  // metadata record in `entity_records`, so the Entity Engine keeps CRUD, validation, field ACL,
  // audit, stream, attachments and search; the Service Desk module adds numbering, the write guard
  // and the `service_desk_case_number_seq` sequence in `apps/api/src/service-desk` and
  // `database/migrations/033_phase19_service_desk.sql`.
  serviceDeskCaseEntity(),
  ...serviceDeskQueueEntities(),
  ...serviceDeskHistoryEntities(),
];

/**
 * `DocumentTemplate` — the kernel-owned way a record becomes a document.
 *
 * A template is a record in the generic store rather than a settings blob, because a template must be
 * listable, editable per entity type, audited, importable and exportable — and the engine in
 * `@carocrm/document` renders it with placeholder names that resolve against whatever data the owning
 * module hands in. See `docs/modules/document/README.md`.
 */
function coreDocumentTemplateEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'DocumentTemplate',
    data: {
      name: 'DocumentTemplate',
      label: 'Document Template',
      isEntity: true,
      fields: salesFields({
        code: { type: 'varchar', maxLength: 64, required: true, inList: true, inDetail: true, inEdit: true },
        // The entity type this template renders. The field is *not* called `entityType`: that name is
        // reserved by the record store (the `entity_type` column and the query engine's physical
        // keys), so an attribute under it would be silently dropped on write. The API keeps accepting
        // `entityType` as its request/query name and maps it here.
        targetEntity: { type: 'varchar', maxLength: 64, required: true, inList: true, inDetail: true, inEdit: true },
        subject: { type: 'varchar', maxLength: 255, inDetail: true, inEdit: true },
        body: { type: 'text', required: true, inDetail: true, inEdit: true },
        format: { type: 'enum', values: ['html', 'text'], defaultValue: 'html', inList: true, inDetail: true, inEdit: true },
        locale: { type: 'varchar', maxLength: 8, inList: true, inDetail: true, inEdit: true },
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        isDefault: { type: 'bool', defaultValue: false, inList: true, inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [
        { name: 'idx_document_template_code', fields: ['code'] },
        { name: 'idx_document_template_entity', fields: ['targetEntity'] },
      ],
      layouts: {
        list: [{ entity: 'DocumentTemplate', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'code', 'targetEntity', 'format', 'locale', 'isDefault', 'active'] }] }],
        detail: [{ entity: 'DocumentTemplate', type: 'detail', panels: [{ name: 'main', label: 'Template', position: 0, fields: ['name', 'description', 'code', 'targetEntity', 'subject', 'body', 'format', 'locale', 'isDefault', 'active'] }] }],
        edit: [{ entity: 'DocumentTemplate', type: 'edit', panels: [{ name: 'main', label: 'Template', position: 0, fields: ['name', 'description', 'code', 'targetEntity', 'subject', 'body', 'format', 'locale', 'isDefault', 'active'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
      acl: {
        permissions: { DocumentTemplate: { create: 'yes', read: 'all', edit: 'yes', delete: 'no', stream: 'all' } },
        // Declarative default (PLAN §8): the body is template source, so a role that may read
        // templates should see them, but a role that may not should not be able to read arbitrary
        // HTML through the generic API either. The shape is the metadata contract — the *per-role*
        // deny lives in the role row's own `field_permissions`, which is what the ACL evaluator
        // reads at runtime.
        fieldPermissions: { DocumentTemplate: { body: 'no' } },
      },
    },
  };
}

/** Fields shared by every Sales entity, with the audit flags this module needs. */
function salesFields(extra: Record<string, Record<string, unknown>> = {}): Record<string, Record<string, unknown>> {
  return {
    ...standardFields,
    name: { ...standardFields['name'], required: true, audited: true },
    ...extra,
  };
}

/**
 * A decimal-as-string field (money, quantity, rate) the query engine can aggregate.
 *
 * Declared as a hoisted function, not a `const`: `coreMetadata` below is evaluated at module load
 * and calls the Sales entity builders, which call this — a `const` would still be in its temporal
 * dead zone at that moment.
 */
function decimalField(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'currency', ...extra };
}

function salesProductEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'Product',
    data: {
      name: 'Product',
      label: 'Product',
      isEntity: true,
      fields: salesFields({
        sku: { type: 'varchar', maxLength: 64, required: true, inList: true, inDetail: true, inEdit: true, sortable: true, audited: true },
        productType: { type: 'enum', values: ['Goods', 'Service'], defaultValue: 'Goods', inList: true, inDetail: true, inEdit: true, audited: true },
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true, audited: true },
        isSellable: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        isPurchasable: { type: 'bool', defaultValue: true, inDetail: true, inEdit: true },
        unit: { type: 'varchar', maxLength: 32, defaultValue: 'unit', inDetail: true, inEdit: true },
        categoryId: { type: 'link', entityKey: 'ProductCategory', inList: true, inDetail: true, inEdit: true },
        taxClassId: { type: 'link', entityKey: 'TaxClass', inDetail: true, inEdit: true },
        defaultTaxCodeId: { type: 'link', entityKey: 'TaxCode', inDetail: true, inEdit: true },
        unitPrice: decimalField({ inDetail: true, inEdit: true }),
        listPrice: decimalField({ inDetail: true, inEdit: true }),
        costPrice: decimalField({ inDetail: true, inEdit: true }),
        // 19-S.15 — variants (§4.2): a family label plus the configured attribute values, stored as
        // a JSON object keyed by the attribute codes from Sales settings. The fields exist whether or
        // not `features.productVariants` is on; the catalog guard validates them only when it is, so
        // Tier 1 stays functional without variants (§4.2 last bullet).
        variantFamily: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true, audited: true },
        variantAttributes: { type: 'text', inDetail: true, inEdit: true },
        // 19-S.15 — stock identity: which unit of measure this product's stock is counted in.
        // `batch`/`serial` only take effect while `features.inventory` is on; a service line is never
        // stock-managed regardless (`inventory.stockManagedProductTypes`).
        stockTracking: { type: 'enum', values: ['none', 'batch', 'serial'], defaultValue: 'none', inList: true, inDetail: true, inEdit: true, audited: true },
      }),
      relations: {
        // 19-S.15 relationship panels: the lots and units this exact product/variant is held as.
        batches: { type: 'oneToMany', target: 'InventoryBatch', mappedBy: 'product' },
        serials: { type: 'oneToMany', target: 'InventorySerial', mappedBy: 'product' },
      },
      indexes: [
        { name: 'idx_product_sku', fields: ['sku'] },
        { name: 'idx_product_category', fields: ['categoryId'] },
        { name: 'idx_product_active', fields: ['active'] },
      ],
      layouts: {
        list: [{ entity: 'Product', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'sku', 'productType', 'categoryId', 'active', 'unitPrice', 'modifiedAt'] }] }],
        detail: [
          {
            entity: 'Product',
            type: 'detail',
            panels: [
              { name: 'overview', label: 'Product', position: 0, fields: ['name', 'description', 'sku', 'productType', 'categoryId', 'unit', 'active'] },
              { name: 'pricing', label: 'Pricing', position: 10, fields: ['unitPrice', 'listPrice', 'costPrice'] },
              { name: 'tax', label: 'Tax', position: 20, fields: ['taxClassId', 'defaultTaxCodeId'] },
              { name: 'variants', label: 'Variants & Tracking', position: 25, fields: ['variantFamily', 'variantAttributes', 'stockTracking'] },
              { name: 'ownership', label: 'Ownership', position: 30, fields: ['assignedUserId', 'teams'] },
            ],
          },
        ],
        edit: [
          {
            entity: 'Product',
            type: 'edit',
            panels: [
              { name: 'main', label: 'Product', position: 0, fields: ['name', 'description', 'sku', 'productType', 'categoryId', 'unit'] },
              { name: 'pricing', label: 'Pricing', position: 10, fields: ['unitPrice', 'listPrice', 'costPrice'] },
              { name: 'configuration', label: 'Configuration', position: 20, fields: ['active', 'isSellable', 'isPurchasable', 'taxClassId', 'defaultTaxCodeId', 'assignedUserId', 'teams'] },
              { name: 'variants', label: 'Variants & Tracking', position: 25, fields: ['variantFamily', 'variantAttributes', 'stockTracking'] },
            ],
          },
        ],
      },
      record: { displayField: 'name', removable: true },
      client: {},
      // Declarative defaults (PLAN §8): a role reads products broadly, but the cost price is a
      // sensitive field a restricted role can be denied. The shape is the metadata contract —
      // `fieldPermissions` is keyed by entity, then by field, then by level (`AclDefinitionSchema`);
      // the *per-role* deny lives in the role row's own `field_permissions`, which is what the ACL
      // evaluator reads at runtime.
      acl: {
        permissions: { Product: { create: 'yes', read: 'all', edit: 'yes', delete: 'no', stream: 'all' } },
        fieldPermissions: { Product: { costPrice: 'no' } },
      },
    },
  };
}

function salesProductCategoryEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'ProductCategory',
    data: {
      name: 'ProductCategory',
      label: 'Product Category',
      isEntity: true,
      fields: salesFields({
        parentId: { type: 'link', entityKey: 'ProductCategory', inList: true, inDetail: true, inEdit: true },
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        sortOrder: { type: 'int', defaultValue: 0, inList: true, inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_product_category_parent', fields: ['parentId'] }],
      layouts: {
        list: [{ entity: 'ProductCategory', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'parentId', 'active', 'sortOrder', 'modifiedAt'] }] }],
        detail: [{ entity: 'ProductCategory', type: 'detail', panels: [{ name: 'main', label: 'Category', position: 0, fields: ['name', 'description', 'parentId', 'active', 'sortOrder'] }] }],
        edit: [{ entity: 'ProductCategory', type: 'edit', panels: [{ name: 'main', label: 'Category', position: 0, fields: ['name', 'description', 'parentId', 'active', 'sortOrder'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesPriceBookEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'PriceBook',
    data: {
      name: 'PriceBook',
      label: 'Price Book',
      isEntity: true,
      fields: salesFields({
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true, inEdit: true },
        accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true, inEdit: true },
        priority: { type: 'int', defaultValue: 100, inList: true, inDetail: true, inEdit: true },
        effectiveFrom: { type: 'date', inDetail: true, inEdit: true },
        effectiveTo: { type: 'date', inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [
        { name: 'idx_price_book_account', fields: ['accountId'] },
        { name: 'idx_price_book_active', fields: ['active'] },
      ],
      layouts: {
        list: [{ entity: 'PriceBook', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'currency', 'accountId', 'priority', 'active', 'modifiedAt'] }] }],
        detail: [{ entity: 'PriceBook', type: 'detail', panels: [{ name: 'main', label: 'Price book', position: 0, fields: ['name', 'description', 'currency', 'accountId', 'priority', 'active', 'effectiveFrom', 'effectiveTo'] }] }],
        edit: [{ entity: 'PriceBook', type: 'edit', panels: [{ name: 'main', label: 'Price book', position: 0, fields: ['name', 'description', 'currency', 'accountId', 'priority', 'active', 'effectiveFrom', 'effectiveTo'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesPriceBookEntryEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'PriceBookEntry',
    data: {
      name: 'PriceBookEntry',
      label: 'Price Book Entry',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields['name'], required: false },
        priceBookId: { type: 'link', entityKey: 'PriceBook', required: true, inList: true, inDetail: true, inEdit: true },
        productId: { type: 'link', entityKey: 'Product', required: true, inList: true, inDetail: true, inEdit: true },
        unitPrice: decimalField({ required: true, inList: true, inDetail: true, inEdit: true }),
        minQuantity: decimalField({ inDetail: true, inEdit: true }),
        unit: { type: 'varchar', maxLength: 32, inDetail: true, inEdit: true },
        currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true, inEdit: true },
        effectiveFrom: { type: 'date', inList: true, inDetail: true, inEdit: true },
        effectiveTo: { type: 'date', inDetail: true, inEdit: true },
      },
      relations: {},
      indexes: [
        { name: 'idx_price_book_entry_book', fields: ['priceBookId'] },
        { name: 'idx_price_book_entry_product', fields: ['productId'] },
      ],
      layouts: {
        list: [{ entity: 'PriceBookEntry', type: 'list', panels: [{ name: 'list', position: 0, fields: ['productId', 'priceBookId', 'unitPrice', 'currency', 'minQuantity', 'effectiveFrom', 'effectiveTo'] }] }],
        detail: [{ entity: 'PriceBookEntry', type: 'detail', panels: [{ name: 'main', label: 'Entry', position: 0, fields: ['priceBookId', 'productId', 'unitPrice', 'currency', 'minQuantity', 'unit', 'effectiveFrom', 'effectiveTo'] }] }],
        edit: [{ entity: 'PriceBookEntry', type: 'edit', panels: [{ name: 'main', label: 'Entry', position: 0, fields: ['priceBookId', 'productId', 'unitPrice', 'currency', 'minQuantity', 'unit', 'effectiveFrom', 'effectiveTo'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesPriceRuleEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'PriceRule',
    data: {
      name: 'PriceRule',
      label: 'Price Rule',
      isEntity: true,
      fields: salesFields({
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        priority: { type: 'int', defaultValue: 100, inList: true, inDetail: true, inEdit: true },
        priceBookId: { type: 'link', entityKey: 'PriceBook', required: true, inList: true, inDetail: true, inEdit: true },
        actionType: { type: 'enum', values: ['percentAdjustment', 'fixedAdjustment', 'setPrice'], defaultValue: 'percentAdjustment', inList: true, inDetail: true, inEdit: true },
        actionValue: decimalField({ inList: true, inDetail: true, inEdit: true }),
        productIds: { type: 'linkMultiple', entityKey: 'Product', inDetail: true, inEdit: true },
        categoryIds: { type: 'linkMultiple', entityKey: 'ProductCategory', inDetail: true, inEdit: true },
        accountIds: { type: 'linkMultiple', entityKey: 'Account', inDetail: true, inEdit: true },
        minQuantity: decimalField({ inDetail: true, inEdit: true }),
        maxQuantity: decimalField({ inDetail: true, inEdit: true }),
        effectiveFrom: { type: 'date', inDetail: true, inEdit: true },
        effectiveTo: { type: 'date', inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_price_rule_book', fields: ['priceBookId'] }],
      layouts: {
        list: [{ entity: 'PriceRule', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'priceBookId', 'actionType', 'actionValue', 'priority', 'active'] }] }],
        detail: [{ entity: 'PriceRule', type: 'detail', panels: [{ name: 'main', label: 'Rule', position: 0, fields: ['name', 'description', 'priceBookId', 'actionType', 'actionValue', 'priority', 'active', 'effectiveFrom', 'effectiveTo'] }, { name: 'criteria', label: 'Criteria', position: 10, fields: ['productIds', 'categoryIds', 'accountIds', 'minQuantity', 'maxQuantity'] }] }],
        edit: [{ entity: 'PriceRule', type: 'edit', panels: [{ name: 'main', label: 'Rule', position: 0, fields: ['name', 'description', 'priceBookId', 'actionType', 'actionValue', 'priority', 'active', 'effectiveFrom', 'effectiveTo'] }, { name: 'criteria', label: 'Criteria', position: 10, fields: ['productIds', 'categoryIds', 'accountIds', 'minQuantity', 'maxQuantity'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesSupplierEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'Supplier',
    data: {
      name: 'Supplier',
      label: 'Supplier',
      isEntity: true,
      fields: salesFields({
        code: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        emailAddress: { type: 'email', inList: true, inDetail: true, inEdit: true },
        phoneNumber: { type: 'phone', inDetail: true, inEdit: true },
        website: { type: 'url', inDetail: true, inEdit: true },
        currency: { type: 'varchar', maxLength: 3, inDetail: true, inEdit: true },
        taxId: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
      }),
      relations: {
        // Every purchasing document this supplier is the counterparty of (§4.12 relationship panels).
        purchaseOrders: { type: 'oneToMany', target: 'PurchaseOrder', mappedBy: 'supplier' },
        receiptOrders: { type: 'oneToMany', target: 'ReceiptOrder', mappedBy: 'supplier' },
        bills: { type: 'oneToMany', target: 'Bill', mappedBy: 'supplier' },
        billCredits: { type: 'oneToMany', target: 'BillCredit', mappedBy: 'supplier' },
        payments: { type: 'oneToMany', target: 'Payment', mappedBy: 'supplier' },
      },
      indexes: [{ name: 'idx_supplier_code', fields: ['code'] }],
      layouts: {
        list: [{ entity: 'Supplier', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'code', 'emailAddress', 'currency', 'active', 'modifiedAt'] }] }],
        detail: [{ entity: 'Supplier', type: 'detail', panels: [{ name: 'main', label: 'Supplier', position: 0, fields: ['name', 'description', 'code', 'emailAddress', 'phoneNumber', 'website', 'currency', 'taxId', 'active', 'assignedUserId', 'teams'] }] }],
        edit: [{ entity: 'Supplier', type: 'edit', panels: [{ name: 'main', label: 'Supplier', position: 0, fields: ['name', 'description', 'code', 'emailAddress', 'phoneNumber', 'website', 'currency', 'taxId', 'active', 'assignedUserId', 'teams'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesSupplierPriceEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'SupplierProductPrice',
    data: {
      name: 'SupplierProductPrice',
      label: 'Supplier Price',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields['name'], required: false },
        supplierId: { type: 'link', entityKey: 'Supplier', required: true, inList: true, inDetail: true, inEdit: true },
        productId: { type: 'link', entityKey: 'Product', required: true, inList: true, inDetail: true, inEdit: true },
        unitPrice: decimalField({ required: true, inList: true, inDetail: true, inEdit: true }),
        currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true, inEdit: true },
        supplierProductCode: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
        minOrderQuantity: decimalField({ inDetail: true, inEdit: true }),
        effectiveFrom: { type: 'date', inDetail: true, inEdit: true },
        effectiveTo: { type: 'date', inDetail: true, inEdit: true },
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
      },
      relations: {},
      indexes: [
        { name: 'idx_supplier_price_supplier', fields: ['supplierId'] },
        { name: 'idx_supplier_price_product', fields: ['productId'] },
      ],
      layouts: {
        list: [{ entity: 'SupplierProductPrice', type: 'list', panels: [{ name: 'list', position: 0, fields: ['productId', 'supplierId', 'unitPrice', 'currency', 'supplierProductCode', 'active'] }] }],
        detail: [{ entity: 'SupplierProductPrice', type: 'detail', panels: [{ name: 'main', label: 'Supplier price', position: 0, fields: ['supplierId', 'productId', 'unitPrice', 'currency', 'supplierProductCode', 'minOrderQuantity', 'effectiveFrom', 'effectiveTo', 'active'] }] }],
        edit: [{ entity: 'SupplierProductPrice', type: 'edit', panels: [{ name: 'main', label: 'Supplier price', position: 0, fields: ['supplierId', 'productId', 'unitPrice', 'currency', 'supplierProductCode', 'minOrderQuantity', 'effectiveFrom', 'effectiveTo', 'active'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesTaxClassEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'TaxClass',
    data: {
      name: 'TaxClass',
      label: 'Tax Class',
      isEntity: true,
      fields: salesFields({
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [],
      layouts: {
        list: [{ entity: 'TaxClass', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'active', 'modifiedAt'] }] }],
        detail: [{ entity: 'TaxClass', type: 'detail', panels: [{ name: 'main', label: 'Tax class', position: 0, fields: ['name', 'description', 'active'] }] }],
        edit: [{ entity: 'TaxClass', type: 'edit', panels: [{ name: 'main', label: 'Tax class', position: 0, fields: ['name', 'description', 'active'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesTaxCodeEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'TaxCode',
    data: {
      name: 'TaxCode',
      label: 'Tax Code',
      isEntity: true,
      fields: salesFields({
        code: { type: 'varchar', maxLength: 32, required: true, inList: true, inDetail: true, inEdit: true },
        // Mapping metadata for an e-invoicing adapter, never a legal classification (plan §4.12).
        externalCode: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_tax_code_code', fields: ['code'] }],
      layouts: {
        list: [{ entity: 'TaxCode', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'code', 'externalCode', 'active', 'modifiedAt'] }] }],
        detail: [{ entity: 'TaxCode', type: 'detail', panels: [{ name: 'main', label: 'Tax code', position: 0, fields: ['name', 'code', 'externalCode', 'description', 'active'] }] }],
        edit: [{ entity: 'TaxCode', type: 'edit', panels: [{ name: 'main', label: 'Tax code', position: 0, fields: ['name', 'code', 'externalCode', 'description', 'active'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesTaxRateEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'TaxRate',
    data: {
      name: 'TaxRate',
      label: 'Tax Rate',
      isEntity: true,
      fields: salesFields({
        taxCodeId: { type: 'link', entityKey: 'TaxCode', required: true, inList: true, inDetail: true, inEdit: true },
        ratePercent: decimalField({ required: true, inList: true, inDetail: true, inEdit: true }),
        jurisdiction: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
        effectiveFrom: { type: 'date', inList: true, inDetail: true, inEdit: true },
        effectiveTo: { type: 'date', inDetail: true, inEdit: true },
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_tax_rate_code', fields: ['taxCodeId'] }],
      layouts: {
        list: [{ entity: 'TaxRate', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'taxCodeId', 'ratePercent', 'jurisdiction', 'effectiveFrom', 'effectiveTo', 'active'] }] }],
        detail: [{ entity: 'TaxRate', type: 'detail', panels: [{ name: 'main', label: 'Tax rate', position: 0, fields: ['name', 'taxCodeId', 'ratePercent', 'jurisdiction', 'effectiveFrom', 'effectiveTo', 'active'] }] }],
        edit: [{ entity: 'TaxRate', type: 'edit', panels: [{ name: 'main', label: 'Tax rate', position: 0, fields: ['name', 'taxCodeId', 'ratePercent', 'jurisdiction', 'effectiveFrom', 'effectiveTo', 'active'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesTaxRuleEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'TaxRule',
    data: {
      name: 'TaxRule',
      label: 'Tax Rule',
      isEntity: true,
      fields: salesFields({
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        priority: { type: 'int', defaultValue: 10, inList: true, inDetail: true, inEdit: true },
        taxCodeId: { type: 'link', entityKey: 'TaxCode', required: true, inList: true, inDetail: true, inEdit: true },
        taxClassId: { type: 'link', entityKey: 'TaxClass', inDetail: true, inEdit: true },
        productIds: { type: 'linkMultiple', entityKey: 'Product', inDetail: true, inEdit: true },
        categoryIds: { type: 'linkMultiple', entityKey: 'ProductCategory', inDetail: true, inEdit: true },
        accountIds: { type: 'linkMultiple', entityKey: 'Account', inDetail: true, inEdit: true },
        jurisdiction: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
        effectiveFrom: { type: 'date', inDetail: true, inEdit: true },
        effectiveTo: { type: 'date', inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_tax_rule_code', fields: ['taxCodeId'] }],
      layouts: {
        list: [{ entity: 'TaxRule', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'taxCodeId', 'priority', 'jurisdiction', 'active'] }] }],
        detail: [{ entity: 'TaxRule', type: 'detail', panels: [{ name: 'main', label: 'Tax rule', position: 0, fields: ['name', 'description', 'taxCodeId', 'priority', 'jurisdiction', 'active', 'effectiveFrom', 'effectiveTo'] }, { name: 'criteria', label: 'Criteria', position: 10, fields: ['taxClassId', 'productIds', 'categoryIds', 'accountIds'] }] }],
        edit: [{ entity: 'TaxRule', type: 'edit', panels: [{ name: 'main', label: 'Tax rule', position: 0, fields: ['name', 'description', 'taxCodeId', 'priority', 'jurisdiction', 'active', 'effectiveFrom', 'effectiveTo'] }, { name: 'criteria', label: 'Criteria', position: 10, fields: ['taxClassId', 'productIds', 'categoryIds', 'accountIds'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 19-S.6 – 19-S.12 — commercial documents
// ---------------------------------------------------------------------------
//
// One builder per entity, driven by a small spec, so a new document type is a spec rather than
// another hundred lines of field declarations. `states` must match
// `apps/api/src/sales/document/descriptors.ts` — the descriptor is the authority for the state
// machine; the enum here is what the Entity Engine validates a write against.

interface DocumentSpec {
  readonly entity: string;
  readonly label: string;
  readonly states: readonly string[];
  readonly dateField: string;
  readonly itemEntity: string;
  readonly itemParentField: string;
  /**
   * The counterparty field the document is *about*, used by the layouts. `accountId` for everything a
   * customer signs; `supplierId` for the purchasing documents, where an account would be meaningless
   * (§4.12).
   */
  readonly partyField?: 'accountId' | 'supplierId';
  readonly extraFields?: Record<string, Record<string, unknown>>;
  readonly extraEditFields?: readonly string[];
  /** Extra fields on the line items (a return line's restock disposition, a receipt line's batch). */
  readonly extraItemFields?: Record<string, Record<string, unknown>>;
  readonly extraItemEditFields?: readonly string[];
  /**
   * Kind-specific relations, on top of the `items` relation every document gets.
   *
   * `mappedBy` names the *child field prefix*: `mappedBy: 'source'` resolves through `sourceId`, which
   * is how a quote finds the sales orders generated from it and an order finds its invoices
   * (PLAN_Phase_19_Sales.md §4.5 "relationship panels for related Opportunity, Sales Orders and
   * generated documents").
   */
  readonly extraRelations?: Record<string, Record<string, unknown>>;
}

/** Fields every commercial document carries: identity, party, money, issuance and lock state. */
function documentFields(spec: DocumentSpec): Record<string, Record<string, unknown>> {
  return {
    ...standardFields,
    // A document's human-readable identity is its number; `name` stays optional and is never used as
    // a substitute for it (§5.6 last bullet).
    name: { ...standardFields['name'], required: false },
    number: { type: 'varchar', maxLength: 32, inList: true, inDetail: true, sortable: true, audited: true },
    status: {
      type: 'enum',
      values: spec.states,
      defaultValue: spec.states[0],
      inList: true,
      inDetail: true,
      inEdit: true,
      audited: true,
    },
    accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true, inEdit: true },
    contactId: { type: 'link', entityKey: 'Contact', inDetail: true, inEdit: true },
    currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true, inEdit: true },
    [spec.dateField]: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
    priceBookId: { type: 'link', entityKey: 'PriceBook', inDetail: true, inEdit: true },
    paymentTermId: { type: 'link', entityKey: 'PaymentTermProfile', inDetail: true, inEdit: true },
    billingAddress: { type: 'text', inDetail: true, inEdit: true },
    shippingAddress: { type: 'text', inDetail: true, inEdit: true },
    shippingAmount: decimalField({ inDetail: true, inEdit: true }),
    shippingTaxCodeId: { type: 'link', entityKey: 'TaxCode', inDetail: true, inEdit: true },
    documentDiscountAmount: decimalField({ inDetail: true, inEdit: true }),
    taxInclusive: { type: 'bool', inDetail: true, inEdit: true },
    jurisdiction: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
    // Server-computed: `inEdit` is omitted everywhere, and the engine rejects these keys a second time
    // (`rejectServerOwned`), so a crafted request cannot set them.
    exchangeRateSnapshot: { type: 'text', inDetail: true },
    itemsCount: { type: 'int', inList: true, inDetail: true },
    subtotal: decimalField({ inList: true, inDetail: true }),
    discountTotal: decimalField({ inDetail: true }),
    shippingTaxAmount: decimalField({ inDetail: true }),
    taxTotal: decimalField({ inList: true, inDetail: true }),
    netTotal: decimalField({ inDetail: true }),
    grossTotal: decimalField({ inList: true, inDetail: true }),
    amountDue: decimalField({ inList: true, inDetail: true }),
    baseCurrency: { type: 'varchar', maxLength: 3, inDetail: true },
    baseGrossTotal: decimalField({ inDetail: true }),
    taxBreakdown: { type: 'text', inDetail: true },
    roundingStage: { type: 'varchar', maxLength: 16, inDetail: true },
    roundingMode: { type: 'varchar', maxLength: 16, inDetail: true },
    settingsVersion: { type: 'int', inDetail: true },
    issuedAt: { type: 'datetime', inList: true, inDetail: true, audited: true },
    issuedBy: { type: 'varchar', maxLength: 64, inDetail: true },
    lockedAt: { type: 'datetime', inDetail: true },
    lockedBy: { type: 'varchar', maxLength: 64, inDetail: true },
    unlockedAt: { type: 'datetime', inDetail: true },
    unlockedBy: { type: 'varchar', maxLength: 64, inDetail: true },
    /** The frozen commercial snapshot (JSON text). Written once, at issuance. */
    snapshot: { type: 'text', inDetail: true },
    sourceEntity: { type: 'varchar', maxLength: 64, inDetail: true },
    sourceId: { type: 'varchar', maxLength: 64, inDetail: true },
    correlationId: { type: 'varchar', maxLength: 128, inDetail: true },
    ...(spec.extraFields ?? {}),
  };
}

/** Fields every line item carries. Money and quantity are canonical decimal strings. */
function documentItemFields(spec: DocumentSpec): Record<string, Record<string, unknown>> {
  return {
    ...standardFields,
    name: { ...standardFields['name'], required: false },
    [spec.itemParentField]: { type: 'link', entityKey: spec.entity, required: true, inList: true },
    position: { type: 'int', required: true, inList: true, inDetail: true, sortable: true },
    /**
     * The line this one was copied from, whatever document kind that was (a quote line becoming an
     * order line, an order line becoming a delivery line). It is what makes partial fulfilment
     * derivable: a confirmed delivery moves quantity *against a specific order line* (§4.10).
     */
    sourceItemId: { type: 'varchar', maxLength: 64, inDetail: true },
    productId: { type: 'link', entityKey: 'Product', inList: true, inDetail: true, inEdit: true },
    sku: { type: 'varchar', maxLength: 64, inList: true, inDetail: true },
    unit: { type: 'varchar', maxLength: 32, inDetail: true },
    quantity: decimalField({ required: true, inList: true, inDetail: true, inEdit: true }),
    unitPrice: decimalField({ inList: true, inDetail: true, inEdit: true }),
    discountPercent: decimalField({ inDetail: true, inEdit: true }),
    discountAmount: decimalField({ inDetail: true }),
    taxCodeId: { type: 'link', entityKey: 'TaxCode', inDetail: true, inEdit: true },
    taxRatePercent: decimalField({ inDetail: true }),
    taxSource: { type: 'varchar', maxLength: 16, inDetail: true },
    taxRuleId: { type: 'varchar', maxLength: 64, inDetail: true },
    netAmount: decimalField({ inList: true, inDetail: true }),
    taxAmount: decimalField({ inDetail: true }),
    grossAmount: decimalField({ inList: true, inDetail: true }),
    ...(spec.extraItemFields ?? {}),
  };
}

function documentEntity(spec: DocumentSpec): MetadataSeedEntry {
  const prefix = spec.entity.toLowerCase();
  const party = spec.partyField ?? 'accountId';
  return {
    scope: 'entity',
    name: spec.entity,
    data: {
      name: spec.entity,
      label: spec.label,
      isEntity: true,
      fields: documentFields(spec),
      relations: {
        // The document's own lines. `mappedBy` is the parent field without its `Id` suffix, which is
        // the convention `attrMatchFor` resolves (`apps/api/src/entity/entity.service.ts`).
        items: { type: 'oneToMany', target: spec.itemEntity, mappedBy: spec.itemParentField.replace(/Id$/, '') },
        ...(spec.extraRelations ?? {}),
      },
      indexes: [
        { name: `idx_${prefix}_status`, fields: ['status'] },
        { name: `idx_${prefix}_account`, fields: [party] },
        { name: `idx_${prefix}_number`, fields: ['number'] },
      ],
      layouts: {
        list: [
          {
            entity: spec.entity,
            type: 'list',
            panels: [
              {
                name: 'list',
                position: 0,
                fields: ['number', 'status', party, spec.dateField, 'currency', 'grossTotal', 'amountDue', 'assignedUserId'],
              },
            ],
          },
        ],
        detail: [
          {
            entity: spec.entity,
            type: 'detail',
            panels: [
              {
                name: 'main',
                label: spec.label,
                position: 0,
                fields: ['number', 'status', party, 'contactId', spec.dateField, 'currency', 'description', 'assignedUserId'],
              },
              {
                name: 'totals',
                label: 'Totals',
                position: 10,
                fields: ['subtotal', 'discountTotal', 'shippingAmount', 'taxTotal', 'netTotal', 'grossTotal', 'amountDue'],
              },
              {
                name: 'issuance',
                label: 'Issuance',
                position: 20,
                fields: ['issuedAt', 'issuedBy', 'lockedAt', 'unlockedAt', 'settingsVersion', 'roundingStage', 'roundingMode'],
              },
            ],
          },
        ],
        edit: [
          {
            entity: spec.entity,
            type: 'edit',
            panels: [
              {
                name: 'main',
                label: spec.label,
                position: 0,
                fields: [party, spec.dateField, 'currency', 'description', ...(spec.extraEditFields ?? [])],
              },
              {
                name: 'terms',
                label: 'Terms',
                position: 10,
                fields: ['priceBookId', 'paymentTermId', 'shippingAmount', 'shippingTaxCodeId', 'documentDiscountAmount', 'taxInclusive', 'billingAddress', 'shippingAddress'],
              },
            ],
          },
        ],
      },
      record: { displayField: 'number', removable: true },
      client: {},
      // Documents start from a usable default: everyone may read, an editor may create and change a
      // draft, nobody deletes an issued one (the engine refuses that regardless of the role).
      acl: { permissions: { [spec.entity]: { create: 'yes', read: 'all', edit: 'yes', delete: 'no', stream: 'all' } } },
    },
  };
}

function documentItemEntity(spec: DocumentSpec): MetadataSeedEntry {
  const prefix = spec.itemEntity.toLowerCase();
  return {
    scope: 'entity',
    name: spec.itemEntity,
    data: {
      name: spec.itemEntity,
      label: `${spec.label} Item`,
      isEntity: true,
      fields: documentItemFields(spec),
      relations: {},
      indexes: [
        { name: `idx_${prefix}_parent`, fields: [spec.itemParentField] },
        { name: `idx_${prefix}_product`, fields: ['productId'] },
      ],
      layouts: {
        list: [
          {
            entity: spec.itemEntity,
            type: 'list',
            panels: [{ name: 'list', position: 0, fields: ['position', 'name', 'sku', 'quantity', 'unitPrice', 'netAmount', 'grossAmount', ...(spec.extraItemEditFields ?? [])] }],
          },
        ],
        detail: [
          {
            entity: spec.itemEntity,
            type: 'detail',
            panels: [
              { name: 'main', label: 'Line', position: 0, fields: ['position', 'productId', 'name', 'sku', 'unit', 'quantity', 'unitPrice', 'discountPercent', 'discountAmount', ...(spec.extraItemEditFields ?? [])] },
              { name: 'tax', label: 'Tax', position: 10, fields: ['taxCodeId', 'taxRatePercent', 'taxSource', 'netAmount', 'taxAmount', 'grossAmount'] },
            ],
          },
        ],
        edit: [
          {
            entity: spec.itemEntity,
            type: 'edit',
            panels: [
              { name: 'main', label: 'Line', position: 0, fields: ['position', 'productId', 'name', 'sku', 'unit', 'quantity', 'unitPrice', 'discountPercent', 'discountAmount', 'taxCodeId', ...(spec.extraItemEditFields ?? [])] },
            ],
          },
        ],
      },
      record: { displayField: 'name', removable: true },
      // Items are reached through their parent document's panel, not from the navigation.
      client: { web: false },
    },
  };
}

/** Payment terms: a named policy a quote, order, invoice or bill can reference (§5.2). */
function salesPaymentTermProfileEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'PaymentTermProfile',
    data: {
      name: 'PaymentTermProfile',
      label: 'Payment Terms',
      isEntity: true,
      fields: salesFields({
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        dueDays: { type: 'int', defaultValue: 30, inList: true, inDetail: true, inEdit: true },
        /** `net` counts from the document date; `endOfMonth` counts from the end of that month. */
        basis: { type: 'enum', values: ['net', 'endOfMonth'], defaultValue: 'net', inList: true, inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_payment_term_profile_active', fields: ['active'] }],
      layouts: {
        list: [{ entity: 'PaymentTermProfile', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'dueDays', 'basis', 'active'] }] }],
        detail: [{ entity: 'PaymentTermProfile', type: 'detail', panels: [{ name: 'main', label: 'Payment terms', position: 0, fields: ['name', 'description', 'dueDays', 'basis', 'active'] }] }],
        edit: [{ entity: 'PaymentTermProfile', type: 'edit', panels: [{ name: 'main', label: 'Payment terms', position: 0, fields: ['name', 'description', 'dueDays', 'basis', 'active'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesQuoteEntity(): MetadataSeedEntry {
  return documentEntity({
    entity: 'Quote',
    label: 'Quote',
    states: ['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted', 'cancelled'],
    dateField: 'quoteDate',
    itemEntity: 'QuoteItem',
    itemParentField: 'quoteId',
    extraFields: {
      validUntil: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
      opportunityId: { type: 'link', entityKey: 'Opportunity', inDetail: true, inEdit: true },
    },
    extraEditFields: ['validUntil', 'opportunityId'],
    extraRelations: { salesOrders: { type: 'oneToMany', target: 'SalesOrder', mappedBy: 'source' } },
  });
}

function salesQuoteItemEntity(): MetadataSeedEntry {
  return documentItemEntity({ entity: 'Quote', label: 'Quote', states: ['draft'], dateField: 'quoteDate', itemEntity: 'QuoteItem', itemParentField: 'quoteId' });
}

function salesSalesOrderEntity(): MetadataSeedEntry {
  return documentEntity({
    entity: 'SalesOrder',
    label: 'Sales Order',
    states: ['draft', 'confirmed', 'partiallyFulfilled', 'fulfilled', 'cancelled'],
    dateField: 'orderDate',
    itemEntity: 'SalesOrderItem',
    itemParentField: 'salesOrderId',
    extraFields: {
      opportunityId: { type: 'link', entityKey: 'Opportunity', inDetail: true, inEdit: true },
      requiredDeliveryDate: { type: 'date', inList: true, inDetail: true, inEdit: true },
      //
      // Deliberately a bare id (not a `link` to `Warehouse`): a draft may be prepared before a
      // location is chosen, and an issued document must keep rendering after its warehouse is
      // deactivated. 19-S.14 resolves and validates it against the registered `Warehouse` at the
      // moment stock actually moves (`InventoryService.requireWarehouse`), which is where a bad id
      // must be refused — not at draft save.
      warehouseId: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
    },
    extraEditFields: ['requiredDeliveryDate', 'warehouseId', 'opportunityId'],
    extraRelations: {
      invoices: { type: 'oneToMany', target: 'Invoice', mappedBy: 'source' },
      deliveryOrders: { type: 'oneToMany', target: 'DeliveryOrder', mappedBy: 'salesOrder' },
      returnOrders: { type: 'oneToMany', target: 'ReturnOrder', mappedBy: 'salesOrder' },
    },
  });
}

function salesSalesOrderItemEntity(): MetadataSeedEntry {
  return documentItemEntity({
    entity: 'SalesOrder',
    label: 'Sales Order',
    states: ['draft'],
    dateField: 'orderDate',
    itemEntity: 'SalesOrderItem',
    itemParentField: 'salesOrderId',
  });
}

function salesInvoiceEntity(): MetadataSeedEntry {
  return documentEntity({
    entity: 'Invoice',
    label: 'Invoice',
    states: ['draft', 'issued', 'voided'],
    dateField: 'invoiceDate',
    itemEntity: 'InvoiceItem',
    itemParentField: 'invoiceId',
    extraFields: {
      dueDate: { type: 'date', inList: true, inDetail: true, sortable: true },
      deliveryDate: { type: 'date', inDetail: true, inEdit: true },
      servicePeriodStart: { type: 'date', inDetail: true, inEdit: true },
      servicePeriodEnd: { type: 'date', inDetail: true, inEdit: true },
      /**
       * Payment state is a **separate concept** from document status (§4.7): `status` says whether the
       * document is a draft or issued, `paymentStatus` says how much of it has been settled. Neither
       * stands in for the other.
       */
      paymentStatus: { type: 'enum', values: ['unpaid', 'partiallyPaid', 'paid', 'overdue'], defaultValue: 'unpaid', inList: true, inDetail: true },
      salesOrderId: { type: 'link', entityKey: 'SalesOrder', inDetail: true },
      subscriptionId: { type: 'link', entityKey: 'Subscription', inDetail: true },
      subscriptionPeriodId: { type: 'link', entityKey: 'SubscriptionPeriod', inDetail: true },
    },
    extraEditFields: ['dueDate', 'deliveryDate', 'servicePeriodStart', 'servicePeriodEnd'],
    extraRelations: {
      // The payment history panel: every allocation that settles this invoice (§4.8).
      allocations: { type: 'oneToMany', target: 'PaymentAllocation', mappedBy: 'document' },
      creditAllocations: { type: 'oneToMany', target: 'CreditNoteAllocation', mappedBy: 'invoice' },
      writeOffs: { type: 'oneToMany', target: 'WriteOff', mappedBy: 'invoice' },
    },
  });
}

function salesInvoiceItemEntity(): MetadataSeedEntry {
  return documentItemEntity({ entity: 'Invoice', label: 'Invoice', states: ['draft'], dateField: 'invoiceDate', itemEntity: 'InvoiceItem', itemParentField: 'invoiceId' });
}

function salesCreditNoteEntity(): MetadataSeedEntry {
  return documentEntity({
    entity: 'CreditNote',
    label: 'Credit Note',
    states: ['draft', 'issued', 'voided'],
    dateField: 'creditDate',
    itemEntity: 'CreditNoteItem',
    itemParentField: 'creditNoteId',
    extraFields: {
      invoiceId: { type: 'link', entityKey: 'Invoice', inList: true, inDetail: true, inEdit: true },
      reason: { type: 'varchar', maxLength: 255, inDetail: true, inEdit: true },
      /** Credit not yet allocated to an invoice; visible and reportable (§4.9). */
      unallocatedAmount: decimalField({ inList: true, inDetail: true }),
    },
    extraEditFields: ['invoiceId', 'reason'],
    extraRelations: { allocations: { type: 'oneToMany', target: 'CreditNoteAllocation', mappedBy: 'creditNote' } },
  });
}

function salesCreditNoteItemEntity(): MetadataSeedEntry {
  return documentItemEntity({ entity: 'CreditNote', label: 'Credit Note', states: ['draft'], dateField: 'creditDate', itemEntity: 'CreditNoteItem', itemParentField: 'creditNoteId' });
}

function salesDeliveryOrderEntity(): MetadataSeedEntry {
  return documentEntity({
    entity: 'DeliveryOrder',
    label: 'Delivery Order',
    states: ['draft', 'confirmed', 'delivered', 'cancelled'],
    dateField: 'deliveryDate',
    itemEntity: 'DeliveryOrderItem',
    itemParentField: 'deliveryOrderId',
    extraFields: {
      salesOrderId: { type: 'link', entityKey: 'SalesOrder', inList: true, inDetail: true },
      trackingNumber: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
      warehouseId: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
    },
    extraEditFields: ['trackingNumber', 'warehouseId'],
  });
}

function salesDeliveryOrderItemEntity(): MetadataSeedEntry {
  return documentItemEntity({
    entity: 'DeliveryOrder',
    label: 'Delivery Order',
    states: ['draft'],
    dateField: 'deliveryDate',
    itemEntity: 'DeliveryOrderItem',
    itemParentField: 'deliveryOrderId',
    /**
     * 19-S.15: which lot (or which serialised units) this line ships. Optional — an unlabelled line
     * is picked by the configured removal policy at confirmation; a labelled one is the operator's
     * explicit choice and is validated against attributed stock when the movement is applied.
     */
    extraItemFields: {
      batchNumber: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
      serialNumbers: { type: 'text', inDetail: true, inEdit: true },
    },
    extraItemEditFields: ['batchNumber', 'serialNumbers'],
  });
}

function salesReturnOrderEntity(): MetadataSeedEntry {
  return documentEntity({
    entity: 'ReturnOrder',
    label: 'Return Order',
    states: ['draft', 'confirmed', 'cancelled'],
    dateField: 'returnDate',
    itemEntity: 'ReturnOrderItem',
    itemParentField: 'returnOrderId',
    extraFields: {
      salesOrderId: { type: 'link', entityKey: 'SalesOrder', inList: true, inDetail: true },
      deliveryOrderId: { type: 'link', entityKey: 'DeliveryOrder', inList: true, inDetail: true, inEdit: true },
      warehouseId: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
      reason: { type: 'varchar', maxLength: 255, inDetail: true, inEdit: true },
    },
    extraEditFields: ['deliveryOrderId', 'warehouseId', 'reason'],
  });
}

function salesReturnOrderItemEntity(): MetadataSeedEntry {
  return documentItemEntity({
    entity: 'ReturnOrder',
    label: 'Return Order',
    states: ['draft'],
    dateField: 'returnDate',
    itemEntity: 'ReturnOrderItem',
    itemParentField: 'returnOrderId',
    /**
     * What happens to the returned goods (19-S.12). `restock` is the only disposition that may
     * produce an inbound stock movement; the rest of the line is still on record so the operator can
     * see what was scrapped or quarantined next to what came back. The authority for the gate is
     * `apps/api/src/sales/document/stock-movement.ts`, and both are unit-tested together.
     */
    extraItemFields: {
      disposition: {
        type: 'enum',
        values: ['restock', 'scrap', 'quarantine'],
        defaultValue: 'restock',
        inList: true,
        inDetail: true,
      },
      // 19-S.15: a restocked return must name the lot (and the units) it comes back as — an inbound
      // movement has nothing to pick from, so the operator records the identity with the disposition.
      batchNumber: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
      serialNumbers: { type: 'text', inDetail: true, inEdit: true },
    },
    extraItemEditFields: ['disposition', 'batchNumber', 'serialNumbers'],
  });
}

// ---------------------------------------------------------------------------
// Phase 19-S.13 — purchasing: purchase orders, receipt orders, supplier bills and bill credits
// ---------------------------------------------------------------------------
//
// The purchasing documents are the same engine with the supplier in the account's seat. What they must
// *not* share with the selling side is price: a purchase price is a `SupplierProductPrice`
// (19-S.5), the sales engine never reads it, and the only copying that crosses the two is the
// terms/address a purchase order references for its own totals (PLAN §4.12, acceptance criterion
// "supplier prices never leak into sales pricing").

function salesPurchaseOrderEntity(): MetadataSeedEntry {
  return documentEntity({
    entity: 'PurchaseOrder',
    label: 'Purchase Order',
    states: ['draft', 'confirmed', 'partiallyReceived', 'received', 'cancelled'],
    dateField: 'orderDate',
    itemEntity: 'PurchaseOrderItem',
    itemParentField: 'purchaseOrderId',
    partyField: 'supplierId',
    extraFields: {
      supplierId: { type: 'link', entityKey: 'Supplier', inList: true, inDetail: true, inEdit: true },
      warehouseId: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
      expectedDeliveryDate: { type: 'date', inList: true, inDetail: true, inEdit: true },
    },
    extraEditFields: ['supplierId', 'warehouseId', 'expectedDeliveryDate'],
    extraRelations: {
      // Receipt orders generated from this order, and the bills raised against it (§4.12).
      receipts: { type: 'oneToMany', target: 'ReceiptOrder', mappedBy: 'purchaseOrder' },
      bills: { type: 'oneToMany', target: 'Bill', mappedBy: 'purchaseOrder' },
    },
  });
}

function salesPurchaseOrderItemEntity(): MetadataSeedEntry {
  return documentItemEntity({
    entity: 'PurchaseOrder',
    label: 'Purchase Order',
    states: ['draft'],
    dateField: 'orderDate',
    itemEntity: 'PurchaseOrderItem',
    itemParentField: 'purchaseOrderId',
    /**
     * Which supplier price this line was agreed at. Referenced by id so the number stays auditable
     * after the price list changes, and never copied into sales pricing.
     */
    extraItemFields: {
      supplierProductPriceId: { type: 'varchar', maxLength: 64, inDetail: true },
    },
    extraItemEditFields: ['supplierProductPriceId'],
  });
}

function salesReceiptOrderEntity(): MetadataSeedEntry {
  return documentEntity({
    entity: 'ReceiptOrder',
    label: 'Receipt Order',
    states: ['draft', 'confirmed', 'cancelled'],
    dateField: 'receiptDate',
    itemEntity: 'ReceiptOrderItem',
    itemParentField: 'receiptOrderId',
    partyField: 'supplierId',
    extraFields: {
      supplierId: { type: 'link', entityKey: 'Supplier', inList: true, inDetail: true, inEdit: true },
      purchaseOrderId: { type: 'link', entityKey: 'PurchaseOrder', inList: true, inDetail: true, inEdit: true },
      warehouseId: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
      trackingNumber: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
    },
    extraEditFields: ['supplierId', 'purchaseOrderId', 'warehouseId', 'trackingNumber'],
  });
}

function salesReceiptOrderItemEntity(): MetadataSeedEntry {
  return documentItemEntity({
    entity: 'ReceiptOrder',
    label: 'Receipt Order',
    states: ['draft'],
    dateField: 'receiptDate',
    itemEntity: 'ReceiptOrderItem',
    itemParentField: 'receiptOrderId',
    /**
     * The receiving facts: which supplier price the line arrived at, and the batch/serial identity a
     * physical receipt needs (§4.12 "link receipt lines to product/supplier price/warehouse/
     * batch-serial").
     */
    extraItemFields: {
      supplierProductPriceId: { type: 'varchar', maxLength: 64, inDetail: true },
      batchNumber: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
      serialNumber: { type: 'varchar', maxLength: 128, inDetail: true },
      // 19-S.15: a serialised receipt names every unit it creates — one JSON array of serial numbers
      // (`serialNumbers`), because a line moves a count of units, not one identity. `serialNumber`
      // stays for the single-unit line the 19-S.13 shape already carries.
      serialNumbers: { type: 'text', inDetail: true, inEdit: true },
      // 19-S.15: the lot's dates are recorded with the receipt that creates it (§4.15 expiry data).
      manufacturingDate: { type: 'date', inDetail: true, inEdit: true },
      expiryDate: { type: 'date', inDetail: true, inEdit: true },
    },
    extraItemEditFields: ['supplierProductPriceId', 'batchNumber', 'serialNumber', 'serialNumbers', 'manufacturingDate', 'expiryDate'],
  });
}

function salesBillEntity(): MetadataSeedEntry {
  return documentEntity({
    entity: 'Bill',
    label: 'Bill',
    states: ['draft', 'issued', 'voided'],
    dateField: 'billDate',
    itemEntity: 'BillItem',
    itemParentField: 'billId',
    partyField: 'supplierId',
    extraFields: {
      supplierId: { type: 'link', entityKey: 'Supplier', inList: true, inDetail: true, inEdit: true },
      purchaseOrderId: { type: 'link', entityKey: 'PurchaseOrder', inDetail: true },
      receiptOrderId: { type: 'link', entityKey: 'ReceiptOrder', inDetail: true },
      /** Filled from `paymentTermId` exactly the way an invoice's is (19-S.9), never typed by hand. */
      dueDate: { type: 'date', inList: true, inDetail: true, sortable: true },
      /** The payable twin of an invoice's payment state: separate from `status`, derived from allocations (§4.7, §4.12). */
      paymentStatus: { type: 'enum', values: ['unpaid', 'partiallyPaid', 'paid', 'overdue'], defaultValue: 'unpaid', inList: true, inDetail: true },
      warehouseId: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
    },
    extraEditFields: ['supplierId', 'warehouseId', 'dueDate'],
    extraRelations: {
      // The payment history panel: every allocation that settles this bill (§4.12).
      allocations: { type: 'oneToMany', target: 'PaymentAllocation', mappedBy: 'document' },
      creditAllocations: { type: 'oneToMany', target: 'BillCreditAllocation', mappedBy: 'bill' },
    },
  });
}

function salesBillItemEntity(): MetadataSeedEntry {
  return documentItemEntity({
    entity: 'Bill',
    label: 'Bill',
    states: ['draft'],
    dateField: 'billDate',
    itemEntity: 'BillItem',
    itemParentField: 'billId',
    extraItemFields: {
      supplierProductPriceId: { type: 'varchar', maxLength: 64, inDetail: true },
    },
    extraItemEditFields: ['supplierProductPriceId'],
  });
}

function salesBillCreditEntity(): MetadataSeedEntry {
  return documentEntity({
    entity: 'BillCredit',
    label: 'Bill Credit',
    states: ['draft', 'issued', 'voided'],
    dateField: 'creditDate',
    itemEntity: 'BillCreditItem',
    itemParentField: 'billCreditId',
    partyField: 'supplierId',
    extraFields: {
      supplierId: { type: 'link', entityKey: 'Supplier', inList: true, inDetail: true, inEdit: true },
      /** The bill this credit corrects; set by the `convertToBillCredit` conversion (§4.12). */
      billId: { type: 'link', entityKey: 'Bill', inList: true, inDetail: true, inEdit: true },
      reason: { type: 'varchar', maxLength: 255, inDetail: true, inEdit: true },
      /** Credit not yet allocated to a bill; visible and reportable, derived like a credit note's. */
      unallocatedAmount: decimalField({ inList: true, inDetail: true }),
    },
    extraEditFields: ['supplierId', 'billId', 'reason'],
    extraRelations: { allocations: { type: 'oneToMany', target: 'BillCreditAllocation', mappedBy: 'billCredit' } },
  });
}

function salesBillCreditItemEntity(): MetadataSeedEntry {
  return documentItemEntity({ entity: 'BillCredit', label: 'Bill Credit', states: ['draft'], dateField: 'creditDate', itemEntity: 'BillCreditItem', itemParentField: 'billCreditId' });
}

/**
 * A bill credit applied to a supplier bill — the record that reduces a payable (§4.12).
 *
 * The twin of `CreditNoteAllocation`, and deliberately a separate entity: the reversal trail, the
 * audit fields and the "reversing twice is refused" rule are the same, but a record that settles a
 * customer's receivable and a record that reduces what the organisation owes are not interchangeable
 * rows in one table.
 */
function salesBillCreditAllocationEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'BillCreditAllocation',
    data: {
      name: 'BillCreditAllocation',
      label: 'Bill Credit Allocation',
      isEntity: true,
      fields: salesFields({
        billCreditId: { type: 'link', entityKey: 'BillCredit', required: true, inList: true, inDetail: true },
        billId: { type: 'link', entityKey: 'Bill', required: true, inList: true, inDetail: true },
        amount: decimalField({ required: true, inList: true, inDetail: true }),
        currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true },
        allocatedAt: { type: 'datetime', inList: true, inDetail: true },
        allocatedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        reversedAt: { type: 'datetime', inDetail: true },
        reversedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        reversalReason: { type: 'varchar', maxLength: 255, inDetail: true },
        /** 19-S.18 — this credit applied at the credit note's own frozen rate (§4.13). */
        baseCurrency: { type: 'varchar', maxLength: 3, inDetail: true },
        baseAmount: decimalField({ inDetail: true }),
      }),
      relations: {},
      indexes: [
        { name: 'idx_bill_credit_allocation_note', fields: ['billCreditId'] },
        { name: 'idx_bill_credit_allocation_bill', fields: ['billId'] },
      ],
      layouts: {
        list: [{ entity: 'BillCreditAllocation', type: 'list', panels: [{ name: 'list', position: 0, fields: ['billCreditId', 'billId', 'amount', 'currency', 'allocatedAt'] }] }],
        detail: [{ entity: 'BillCreditAllocation', type: 'detail', panels: [{ name: 'main', label: 'Bill credit allocation', position: 0, fields: ['billCreditId', 'billId', 'amount', 'currency', 'allocatedAt', 'allocatedBy', 'reversedAt', 'reversalReason'] }] }],
        edit: [],
      },
      record: { displayField: 'name', removable: false },
      client: { web: false },
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 19-S.16 — subscriptions and recurring billing (`sales`)
//
// Two records and one rule. `Subscription` is the commercial agreement (who, what, how often, from
// when); `SubscriptionPeriod` is one concrete billed window of it. Everything about a period is
// *derived* — its window, its planned invoice date, its status, its invoice link — so those fields
// are declared for reading and deliberately left out of the edit surface: the billing service owns
// them (`sales-write-guard.service.ts`), which is what makes a replayed run idempotent (§4.14).
// ---------------------------------------------------------------------------
function salesSubscriptionEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'Subscription',
    data: {
      name: 'Subscription',
      label: 'Subscription',
      isEntity: true,
      fields: salesFields({
        status: { type: 'enum', values: ['pending', 'active', 'paused', 'ended', 'cancelled', 'billingFailed', 'renewed'], defaultValue: 'pending', inList: true, inDetail: true, audited: true },
        accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true, inEdit: true },
        contactId: { type: 'link', entityKey: 'Contact', inDetail: true, inEdit: true },
        productId: { type: 'link', entityKey: 'Product', inList: true, inDetail: true, inEdit: true },
        priceBookId: { type: 'link', entityKey: 'PriceBook', inDetail: true, inEdit: true },
        paymentTermId: { type: 'link', entityKey: 'PaymentTermProfile', inDetail: true, inEdit: true },
        taxCodeId: { type: 'link', entityKey: 'TaxCode', inDetail: true, inEdit: true },
        quantity: decimalField({ defaultValue: '1', inList: true, inDetail: true, inEdit: true }),
        unitPrice: decimalField({ inList: true, inDetail: true, inEdit: true }),
        currency: { type: 'varchar', maxLength: 3, defaultValue: 'USD', inList: true, inDetail: true, inEdit: true },
        /** Every interval is a whole number of days or months, so a period boundary is always exact. */
        interval: { type: 'enum', values: ['daily', 'weekly', 'monthly', 'quarterly', 'halfYearly', 'annual'], defaultValue: 'monthly', inList: true, inDetail: true, inEdit: true },
        startDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
        endDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
        renewalDate: { type: 'date', inDetail: true, inEdit: true },
        /** Days a period's invoice is planned *before* the period starts; `0` plans it on day one. */
        leadTimeDays: { type: 'int', defaultValue: 0, inDetail: true, inEdit: true },
        autoRenew: { type: 'bool', defaultValue: true, inDetail: true, inEdit: true },
        idempotencyKey: { type: 'varchar', maxLength: 128, inDetail: true },
      }),
      relations: {
        periods: { type: 'oneToMany', target: 'SubscriptionPeriod', mappedBy: 'subscriptionId' },
        invoices: { type: 'oneToMany', target: 'Invoice', mappedBy: 'subscriptionId' },
      },
      indexes: [{ name: 'idx_subscription_status', fields: ['status'] }],
      layouts: {
        list: [{ entity: 'Subscription', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'status', 'accountId', 'productId', 'interval', 'startDate', 'endDate', 'currency', 'unitPrice', 'quantity'] }] }],
        detail: [{ entity: 'Subscription', type: 'detail', panels: [{ name: 'main', label: 'Subscription', position: 0, fields: ['name', 'status', 'accountId', 'contactId', 'productId', 'quantity', 'unitPrice', 'currency', 'interval', 'startDate', 'endDate', 'renewalDate', 'leadTimeDays', 'autoRenew', 'paymentTermId', 'taxCodeId'] }] }],
        edit: [{ entity: 'Subscription', type: 'edit', panels: [{ name: 'main', label: 'Subscription', position: 0, fields: ['name', 'accountId', 'contactId', 'productId', 'priceBookId', 'quantity', 'unitPrice', 'currency', 'interval', 'startDate', 'endDate', 'renewalDate', 'leadTimeDays', 'autoRenew', 'paymentTermId', 'taxCodeId'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
      // `status` moves through the Sales commands, not through a record edit; nobody deletes a term
      // that produced invoices.
      acl: { permissions: { Subscription: { create: 'yes', read: 'all', edit: 'yes', delete: 'no', stream: 'all' } } },
    },
  };
}

function salesSubscriptionPeriodEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'SubscriptionPeriod',
    data: {
      name: 'SubscriptionPeriod',
      label: 'Subscription Period',
      isEntity: true,
      fields: salesFields({
        status: { type: 'enum', values: ['pending', 'processing', 'invoiced', 'failed', 'skipped', 'cancelled'], defaultValue: 'pending', inList: true, inDetail: true, audited: true },
        subscriptionId: { type: 'link', entityKey: 'Subscription', required: true, inList: true, inDetail: true },
        // The window and its planned invoice date are computed by `subscriptions/schedule.ts`; the
        // billing outcome below is computed by the billing service. None of them is editable.
        periodStart: { type: 'date', required: true, inList: true, inDetail: true, sortable: true },
        periodEnd: { type: 'date', required: true, inList: true, inDetail: true, sortable: true },
        plannedInvoiceDate: { type: 'date', inList: true, inDetail: true, sortable: true },
        invoiceDate: { type: 'date', inDetail: true, sortable: true },
        invoiceId: { type: 'link', entityKey: 'Invoice', inList: true, inDetail: true },
        generatedInvoiceId: { type: 'varchar', maxLength: 64, inDetail: true },
        attemptCount: { type: 'int', defaultValue: 0, inList: true, inDetail: true },
        failureCode: { type: 'varchar', maxLength: 255, inDetail: true },
        retryState: { type: 'varchar', maxLength: 64, inDetail: true },
        idempotencyKey: { type: 'varchar', maxLength: 128, inDetail: true },
      }),
      relations: {
        subscription: { type: 'manyToOne', target: 'Subscription', foreignKey: 'subscriptionId' },
        invoice: { type: 'manyToOne', target: 'Invoice', foreignKey: 'invoiceId' },
        invoices: { type: 'oneToMany', target: 'Invoice', mappedBy: 'subscriptionPeriodId' },
      },
      indexes: [{ name: 'idx_subscription_period_subscription', fields: ['subscriptionId'] }],
      layouts: {
        list: [{ entity: 'SubscriptionPeriod', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'status', 'subscriptionId', 'periodStart', 'periodEnd', 'plannedInvoiceDate', 'invoiceDate', 'invoiceId', 'attemptCount'] }] }],
        detail: [{ entity: 'SubscriptionPeriod', type: 'detail', panels: [{ name: 'main', label: 'Subscription period', position: 0, fields: ['name', 'status', 'subscriptionId', 'periodStart', 'periodEnd', 'plannedInvoiceDate', 'invoiceDate', 'invoiceId', 'attemptCount', 'failureCode', 'retryState', 'idempotencyKey'] }] }],
        // Nothing about a period is hand-editable: it is a computed schedule row.
        edit: [],
      },
      record: { displayField: 'name', removable: true },
      client: {},
      // A period's *record API* is closed by the write guard, not by the ACL: the billing commands
      // are the sanctioned way to create one, so a role that may generate periods needs `create`
      // here. Nobody deletes one — a period is the record of what was billed.
      acl: { permissions: { SubscriptionPeriod: { create: 'yes', read: 'all', edit: 'yes', delete: 'no', stream: 'all' } } },
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 19-S.14 — inventory: warehouses, the stock ledger, transfers and reservations
// ---------------------------------------------------------------------------
//
// The ledger is an **append-only** record stream, not an editable entity: every physical quantity
// change is a row with a signed delta, a transaction type, a source document and (where one is
// needed) a reason, and a correction is a *new, compensating* row rather than an edit (§4.15
// invariant 4). It is a metadata entity so list/detail/search/ACL/audit come from the Entity Engine;
// the write guard refuses every client write, and only `InventoryService` writes it.
//
// Availability is *not* stored here: `on_hand` is the sum of the ledger, and the persisted projection
// (`sales_inventory_stock`, migration 028) exists for locking and fast reads. Neither is a metadata
// entity — the projection is module infrastructure, exactly like `sales_number_series`.

/** A physical location stock is tracked at (§4.15). */
function salesWarehouseEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'Warehouse',
    data: {
      name: 'Warehouse',
      label: 'Warehouse',
      isEntity: true,
      fields: salesFields({
        code: { type: 'varchar', maxLength: 32, inList: true, inDetail: true, inEdit: true, sortable: true, audited: true },
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true, audited: true },
        address: { type: 'text', inDetail: true, inEdit: true },
        sortOrder: { type: 'int', defaultValue: 0, inList: true, inDetail: true, inEdit: true },
        /** The fallback when a stock-moving document names no warehouse and settings do not either. */
        isDefault: { type: 'bool', defaultValue: false, inList: true, inDetail: true, inEdit: true },
      }),
      relations: {
        // The movements recorded at this location.
        transactions: { type: 'oneToMany', target: 'InventoryTransaction', mappedBy: 'warehouse' },
      },
      indexes: [
        { name: 'idx_warehouse_code', fields: ['code'] },
        { name: 'idx_warehouse_active', fields: ['active'] },
      ],
      layouts: {
        list: [{ entity: 'Warehouse', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'code', 'active', 'isDefault', 'sortOrder', 'modifiedAt'] }] }],
        detail: [{ entity: 'Warehouse', type: 'detail', panels: [{ name: 'main', label: 'Warehouse', position: 0, fields: ['name', 'description', 'code', 'address', 'active', 'isDefault', 'sortOrder', 'assignedUserId', 'teams'] }] }],
        edit: [{ entity: 'Warehouse', type: 'edit', panels: [{ name: 'main', label: 'Warehouse', position: 0, fields: ['name', 'description', 'code', 'address', 'active', 'isDefault', 'sortOrder', 'assignedUserId', 'teams'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

/**
 * One immutable stock movement. `transactionType` values mirror `INVENTORY_TRANSACTION_TYPES` in
 * `apps/api/src/sales/inventory/ledger.ts`; the sign of `quantityDelta` is fixed by the type.
 */
function salesInventoryTransactionEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'InventoryTransaction',
    data: {
      name: 'InventoryTransaction',
      label: 'Inventory Transaction',
      isEntity: true,
      fields: salesFields({
        transactionType: { type: 'enum', values: ['openingBalance', 'receipt', 'delivery', 'return', 'adjustment', 'transferOut', 'transferIn', 'correction'], required: true, inList: true, inDetail: true, sortable: true },
        productId: { type: 'link', entityKey: 'Product', required: true, inList: true, inDetail: true },
        warehouseId: { type: 'link', entityKey: 'Warehouse', required: true, inList: true, inDetail: true },
        /** Signed: outbound movements are negative. Canonical decimal string, never a JSON number. */
        quantityDelta: decimalField({ required: true, inList: true, inDetail: true }),
        /** The projection's on-hand for the pair immediately after this row — a printed audit trail. */
        balanceAfter: decimalField({ inList: true, inDetail: true }),
        sourceEntity: { type: 'varchar', maxLength: 64, inList: true, inDetail: true },
        sourceId: { type: 'varchar', maxLength: 64, inDetail: true },
        sourceNumber: { type: 'varchar', maxLength: 64, inList: true, inDetail: true },
        /** The idempotency key; unique across the ledger (migration 028). */
        movementKey: { type: 'varchar', maxLength: 200, inDetail: true },
        /** Pairs the two sides of one transfer. */
        transferGroupId: { type: 'varchar', maxLength: 64, inDetail: true },
        // 19-S.15 — stock identity, recorded with the movement it belongs to (§4.15 "batch/serial
        // references"). `batchNumber` is the single-lot case for a fast filter; `batchAllocations`
        // is the JSON breakdown when one line split across lots; `serialNumbers` is the JSON array of
        // units this movement created or consumed.
        batchNumber: { type: 'varchar', maxLength: 64, inList: true, inDetail: true },
        batchAllocations: { type: 'text', inDetail: true },
        serialNumbers: { type: 'text', inDetail: true },
        reason: { type: 'varchar', maxLength: 255, inList: true, inDetail: true },
        occurredAt: { type: 'datetime', required: true, inList: true, inDetail: true, sortable: true },
        actor: { type: 'varchar', maxLength: 64, inDetail: true },
      }),
      relations: {},
      indexes: [
        { name: 'idx_inventory_transaction_product', fields: ['productId'] },
        { name: 'idx_inventory_transaction_warehouse', fields: ['warehouseId'] },
        { name: 'idx_inventory_transaction_source', fields: ['sourceEntity', 'sourceId'] },
      ],
      layouts: {
        list: [{ entity: 'InventoryTransaction', type: 'list', panels: [{ name: 'list', position: 0, fields: ['occurredAt', 'transactionType', 'productId', 'warehouseId', 'quantityDelta', 'balanceAfter', 'sourceNumber'] }] }],
        detail: [{ entity: 'InventoryTransaction', type: 'detail', panels: [{ name: 'main', label: 'Movement', position: 0, fields: ['occurredAt', 'transactionType', 'productId', 'warehouseId', 'quantityDelta', 'balanceAfter', 'sourceEntity', 'sourceId', 'sourceNumber', 'movementKey', 'transferGroupId', 'batchNumber', 'batchAllocations', 'serialNumbers', 'reason', 'actor'] }] }],
        edit: [],
      },
      // Append-only: a correction is a new compensating row, so a ledger row is never removed (§4.15).
      record: { displayField: 'name', removable: false },
      client: {},
      acl: { permissions: { InventoryTransaction: { create: 'yes', read: 'all', edit: 'no', delete: 'no', stream: 'all' } } },
    },
  };
}

/** A reviewed correction to a product/warehouse balance (§4.15 "reviewed corrections"). */
function salesInventoryAdjustmentEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'InventoryAdjustment',
    data: {
      name: 'InventoryAdjustment',
      label: 'Inventory Adjustment',
      isEntity: true,
      fields: salesFields({
        productId: { type: 'link', entityKey: 'Product', required: true, inList: true, inDetail: true },
        warehouseId: { type: 'link', entityKey: 'Warehouse', required: true, inList: true, inDetail: true },
        /** Signed: a write-off is negative, a found-stock correction is positive. */
        quantityDelta: decimalField({ required: true, inList: true, inDetail: true }),
        reason: { type: 'varchar', maxLength: 255, required: true, inList: true, inDetail: true },
        status: { type: 'enum', values: ['pending', 'applied', 'rejected'], defaultValue: 'pending', inList: true, inDetail: true, audited: true },
        requestedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        requestedAt: { type: 'datetime', inList: true, inDetail: true },
        decidedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        decidedAt: { type: 'datetime', inDetail: true },
        decisionReason: { type: 'varchar', maxLength: 255, inDetail: true },
        /** The ledger row the approval wrote; empty while the request is pending. */
        transactionId: { type: 'varchar', maxLength: 64, inDetail: true },
        // 19-S.15: a reviewed correction on a tracked product names the lot (and, for a serialised
        // product, the units) it applies to. An outbound correction without them is picked by the
        // configured removal policy — the reason and the approval are what make it auditable.
        batchNumber: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
        serialNumbers: { type: 'text', inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [
        { name: 'idx_inventory_adjustment_status', fields: ['status'] },
        { name: 'idx_inventory_adjustment_product', fields: ['productId'] },
      ],
      layouts: {
        list: [{ entity: 'InventoryAdjustment', type: 'list', panels: [{ name: 'list', position: 0, fields: ['status', 'productId', 'warehouseId', 'quantityDelta', 'reason', 'requestedAt'] }] }],
        detail: [{ entity: 'InventoryAdjustment', type: 'detail', panels: [{ name: 'main', label: 'Adjustment', position: 0, fields: ['status', 'productId', 'warehouseId', 'quantityDelta', 'reason', 'requestedBy', 'requestedAt', 'decidedBy', 'decidedAt', 'decisionReason', 'transactionId'] }] }],
        edit: [],
      },
      record: { displayField: 'name', removable: false },
      client: {},
    },
  };
}

/**
 * A controlled move of stock between two warehouses (§4.15 invariant 5).
 *
 * `inTransit` is the safe intermediate state: dispatch applies the source outflow and receipt
 * applies the destination inflow, so one half is always visible rather than silently missing.
 */
function salesTransferOrderEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'TransferOrder',
    data: {
      name: 'TransferOrder',
      label: 'Transfer Order',
      isEntity: true,
      fields: salesFields({
        sourceWarehouseId: { type: 'link', entityKey: 'Warehouse', required: true, inList: true, inDetail: true, inEdit: true },
        destinationWarehouseId: { type: 'link', entityKey: 'Warehouse', required: true, inList: true, inDetail: true, inEdit: true },
        transferDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
        status: { type: 'enum', values: ['draft', 'inTransit', 'received', 'cancelled'], defaultValue: 'draft', inList: true, inDetail: true, audited: true },
        reason: { type: 'varchar', maxLength: 255, inDetail: true, inEdit: true },
        trackingNumber: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
        confirmedAt: { type: 'datetime', inDetail: true },
        receivedAt: { type: 'datetime', inDetail: true },
      }),
      relations: {
        items: { type: 'oneToMany', target: 'TransferOrderItem', mappedBy: 'transferOrder' },
      },
      indexes: [
        { name: 'idx_transfer_order_status', fields: ['status'] },
        { name: 'idx_transfer_order_destination', fields: ['destinationWarehouseId'] },
      ],
      layouts: {
        list: [{ entity: 'TransferOrder', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'status', 'sourceWarehouseId', 'destinationWarehouseId', 'transferDate', 'modifiedAt'] }] }],
        detail: [{ entity: 'TransferOrder', type: 'detail', panels: [{ name: 'main', label: 'Transfer', position: 0, fields: ['name', 'description', 'status', 'sourceWarehouseId', 'destinationWarehouseId', 'transferDate', 'trackingNumber', 'reason', 'confirmedAt', 'receivedAt'] }] }],
        edit: [{ entity: 'TransferOrder', type: 'edit', panels: [{ name: 'main', label: 'Transfer', position: 0, fields: ['name', 'description', 'sourceWarehouseId', 'destinationWarehouseId', 'transferDate', 'trackingNumber', 'reason'] }] }],
      },
      record: { displayField: 'name', removable: false },
      client: {},
    },
  };
}

function salesTransferOrderItemEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'TransferOrderItem',
    data: {
      name: 'TransferOrderItem',
      label: 'Transfer Order Item',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields['name'], required: false },
        transferOrderId: { type: 'link', entityKey: 'TransferOrder', required: true, inList: true, inDetail: true },
        position: { type: 'int', defaultValue: 0, inList: true, inDetail: true },
        productId: { type: 'link', entityKey: 'Product', required: true, inList: true, inDetail: true },
        sku: { type: 'varchar', maxLength: 64, inDetail: true },
        unit: { type: 'varchar', maxLength: 32, inDetail: true },
        quantity: decimalField({ required: true, inList: true, inDetail: true }),
        // 19-S.15: what travels on this line. Both are optional — an unlabelled line of a tracked
        // product is picked at dispatch, and the receive side re-applies the very allocation the
        // dispatch recorded, so both halves of the transfer stay traceable to the same units.
        batchNumber: { type: 'varchar', maxLength: 64, inDetail: true },
        serialNumbers: { type: 'text', inDetail: true },
      },
      relations: {},
      indexes: [
        { name: 'idx_transfer_order_item_parent', fields: ['transferOrderId'] },
        { name: 'idx_transfer_order_item_product', fields: ['productId'] },
      ],
      layouts: {
        list: [{ entity: 'TransferOrderItem', type: 'list', panels: [{ name: 'list', position: 0, fields: ['position', 'productId', 'sku', 'quantity'] }] }],
        detail: [{ entity: 'TransferOrderItem', type: 'detail', panels: [{ name: 'main', label: 'Line', position: 0, fields: ['position', 'productId', 'sku', 'unit', 'quantity', 'batchNumber', 'serialNumbers'] }] }],
        edit: [],
      },
      record: { displayField: 'name', removable: false },
      client: { web: false },
    },
  };
}

/**
 * A soft promise of stock, distinct from the physical movement (§4.15 "reservations for outstanding
 * orders"). It reduces `available` and never changes `on_hand`; shipping consumes it.
 */
function salesInventoryReservationEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'InventoryReservation',
    data: {
      name: 'InventoryReservation',
      label: 'Inventory Reservation',
      isEntity: true,
      fields: salesFields({
        productId: { type: 'link', entityKey: 'Product', required: true, inList: true, inDetail: true },
        warehouseId: { type: 'link', entityKey: 'Warehouse', required: true, inList: true, inDetail: true },
        /** The amount still reserved; consumption reduces it and records the total in `consumedQuantity`. */
        quantity: decimalField({ required: true, inList: true, inDetail: true }),
        consumedQuantity: decimalField({ inList: true, inDetail: true }),
        sourceEntity: { type: 'varchar', maxLength: 64, inList: true, inDetail: true },
        sourceId: { type: 'varchar', maxLength: 64, inList: true, inDetail: true },
        sourceNumber: { type: 'varchar', maxLength: 64, inList: true, inDetail: true },
        status: { type: 'enum', values: ['active', 'consumed', 'released'], defaultValue: 'active', inList: true, inDetail: true },
        reservedAt: { type: 'datetime', inList: true, inDetail: true },
        reservedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        releasedAt: { type: 'datetime', inDetail: true },
        releasedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        releaseReason: { type: 'varchar', maxLength: 255, inDetail: true },
        expiresAt: { type: 'date', inDetail: true, inEdit: true },
      }),
      relations: {},
      indexes: [
        { name: 'idx_inventory_reservation_product', fields: ['productId'] },
        { name: 'idx_inventory_reservation_source', fields: ['sourceEntity', 'sourceId'] },
        { name: 'idx_inventory_reservation_status', fields: ['status'] },
      ],
      layouts: {
        list: [{ entity: 'InventoryReservation', type: 'list', panels: [{ name: 'list', position: 0, fields: ['status', 'productId', 'warehouseId', 'quantity', 'consumedQuantity', 'sourceNumber', 'reservedAt'] }] }],
        detail: [{ entity: 'InventoryReservation', type: 'detail', panels: [{ name: 'main', label: 'Reservation', position: 0, fields: ['status', 'productId', 'warehouseId', 'quantity', 'consumedQuantity', 'sourceEntity', 'sourceId', 'sourceNumber', 'reservedAt', 'reservedBy', 'releasedAt', 'releasedBy', 'releaseReason', 'expiresAt'] }] }],
        edit: [],
      },
      record: { displayField: 'name', removable: false },
      client: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 19-S.10 – 19-S.11 — payments and the records that adjust a balance
// ---------------------------------------------------------------------------

/** A configurable lookup (payment method or channel) a payment may reference. */
/**
 * One lot of one product (19-S.15, §4.15 "lot/batch/serial number tracking and expiry data").
 *
 * The record holds the lot's *identity and dates*; its quantity lives in
 * `sales_inventory_batch_stock` (migration 029), a projection the inventory service maintains while
 * the (product, warehouse) level is locked. Identity (`productId` + `batchNumber`) is unique and
 * immutable — a lot that could be renamed into another product's lot would split its stock — while
 * the dates stay editable so an operator can correct a mis-typed expiry before it matters.
 */
function salesInventoryBatchEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'InventoryBatch',
    data: {
      name: 'InventoryBatch',
      label: 'Inventory Batch',
      isEntity: true,
      fields: salesFields({
        productId: { type: 'link', entityKey: 'Product', required: true, inList: true, inDetail: true },
        /** The lot number as entered; uniqueness is case-insensitive and per product (migration 029). */
        batchNumber: { type: 'varchar', maxLength: 64, required: true, inList: true, inDetail: true, sortable: true, audited: true },
        /** The lot's dates (§4.15): both optional, but a lot cannot be made after it expires. */
        manufacturingDate: { type: 'date', inList: true, inDetail: true, inEdit: true },
        expiryDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
        /** When this lot first arrived — the age FIFO/LIFO orders by (§19-S.15 task 4). */
        receivedAt: { type: 'datetime', inList: true, inDetail: true, sortable: true },
        /** The document that first created the lot, for "where did this come from?". */
        sourceEntity: { type: 'varchar', maxLength: 64, inDetail: true },
        sourceId: { type: 'varchar', maxLength: 64, inDetail: true },
        sourceNumber: { type: 'varchar', maxLength: 64, inDetail: true },
      }),
      relations: {},
      indexes: [{ name: 'idx_inventory_batch_product', fields: ['productId'] }],
      layouts: {
        list: [{ entity: 'InventoryBatch', type: 'list', panels: [{ name: 'list', position: 0, fields: ['productId', 'batchNumber', 'expiryDate', 'manufacturingDate', 'receivedAt', 'modifiedAt'] }] }],
        detail: [{ entity: 'InventoryBatch', type: 'detail', panels: [{ name: 'main', label: 'Batch', position: 0, fields: ['productId', 'batchNumber', 'manufacturingDate', 'expiryDate', 'receivedAt', 'sourceEntity', 'sourceId', 'sourceNumber', 'description'] }] }],
        // Identity is immutable and quantities are derived, so the only editable facts are the dates.
        edit: [{ entity: 'InventoryBatch', type: 'edit', panels: [{ name: 'main', label: 'Batch', position: 0, fields: ['description', 'manufacturingDate', 'expiryDate'] }] }],
      },
      record: { displayField: 'batchNumber', removable: false },
      client: {},
      acl: { permissions: { InventoryBatch: { create: 'yes', read: 'all', edit: 'yes', delete: 'no', stream: 'all' } } },
    },
  };
}

/**
 * One serialised unit (19-S.15 task 5).
 *
 * A serial is a *state*, not a quantity: `status` walks `inStock → inTransit → inStock` (transfer)
 * and `inStock → shipped` (delivery) under the same movement that changes the ledger, and the record
 * API may write neither the state nor the identity — a serial created outside a movement would claim
 * a unit exists that no ledger row accounts for. Uniqueness is per product, case-insensitive, for the
 * whole installation (single organization — migration 029).
 */
function salesInventorySerialEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'InventorySerial',
    data: {
      name: 'InventorySerial',
      label: 'Inventory Serial',
      isEntity: true,
      fields: salesFields({
        serialNumber: { type: 'varchar', maxLength: 128, required: true, inList: true, inDetail: true, sortable: true, audited: true },
        productId: { type: 'link', entityKey: 'Product', required: true, inList: true, inDetail: true },
        warehouseId: { type: 'link', entityKey: 'Warehouse', inList: true, inDetail: true },
        status: { type: 'enum', values: ['inStock', 'inTransit', 'shipped', 'retired'], defaultValue: 'inStock', inList: true, inDetail: true, audited: true },
        /** When this unit first arrived — the age FIFO/LIFO orders serials by. */
        receivedAt: { type: 'datetime', inList: true, inDetail: true, sortable: true },
        lastMovementAt: { type: 'datetime', inList: true, inDetail: true },
        sourceEntity: { type: 'varchar', maxLength: 64, inDetail: true },
        sourceId: { type: 'varchar', maxLength: 64, inDetail: true },
        sourceNumber: { type: 'varchar', maxLength: 64, inDetail: true },
      }),
      relations: {},
      indexes: [
        { name: 'idx_inventory_serial_product', fields: ['productId'] },
        { name: 'idx_inventory_serial_status', fields: ['status'] },
      ],
      layouts: {
        list: [{ entity: 'InventorySerial', type: 'list', panels: [{ name: 'list', position: 0, fields: ['serialNumber', 'productId', 'warehouseId', 'status', 'receivedAt', 'lastMovementAt'] }] }],
        detail: [{ entity: 'InventorySerial', type: 'detail', panels: [{ name: 'main', label: 'Serial', position: 0, fields: ['serialNumber', 'productId', 'warehouseId', 'status', 'receivedAt', 'lastMovementAt', 'sourceEntity', 'sourceId', 'sourceNumber', 'description'] }] }],
        edit: [],
      },
      record: { displayField: 'serialNumber', removable: false },
      client: {},
      // The record API must never create or move a unit — but the *permission* is open, because
      // `EntityCrudService.create` asserts ACL for the inventory service too (it runs as the user who
      // confirmed the document). The refusal for a client write is the `sales.writeGuard` hook
      // (`sales-write-guard.service.ts`), which lets an internal movement through and names the rule
      // for everything else — the same shape the ledger uses with its append-only guard.
      acl: { permissions: { InventorySerial: { create: 'yes', read: 'all', edit: 'yes', delete: 'no', stream: 'all' } } },
    },
  };
}

function lookupEntity(entity: string, label: string, extra: Record<string, Record<string, unknown>> = {}): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: entity,
    data: {
      name: entity,
      label,
      isEntity: true,
      fields: salesFields({
        active: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        ...extra,
      }),
      relations: {},
      indexes: [{ name: `idx_${entity.toLowerCase()}_active`, fields: ['active'] }],
      layouts: {
        list: [{ entity, type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'active', 'modifiedAt'] }] }],
        detail: [{ entity, type: 'detail', panels: [{ name: 'main', label, position: 0, fields: ['name', 'description', 'active'] }] }],
        edit: [{ entity, type: 'edit', panels: [{ name: 'main', label, position: 0, fields: ['name', 'description', 'active'] }] }],
      },
      record: { displayField: 'name', removable: true },
      client: {},
    },
  };
}

function salesPaymentMethodEntity(): MetadataSeedEntry {
  return lookupEntity('PaymentMethod', 'Payment Method', {
    /** Some methods carry a reference the operator must record (a cheque number, a transfer id). */
    requiresReference: { type: 'bool', defaultValue: false, inList: true, inDetail: true, inEdit: true },
  });
}

function salesPaymentChannelEntity(): MetadataSeedEntry {
  return lookupEntity('PaymentChannel', 'Payment Channel', {
    /** Which provider-neutral channel this is (bank, cash, an online provider). Never a secret. */
    provider: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
  });
}

function salesPaymentEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'Payment',
    data: {
      name: 'Payment',
      label: 'Payment',
      isEntity: true,
      fields: salesFields({
        amount: decimalField({ required: true, inList: true, inDetail: true, inEdit: true }),
        currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true, inEdit: true },
        direction: { type: 'enum', values: ['incoming', 'outgoing'], defaultValue: 'incoming', inList: true, inDetail: true, inEdit: true },
        paymentDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
        paymentMethodId: { type: 'link', entityKey: 'PaymentMethod', inList: true, inDetail: true, inEdit: true },
        paymentChannelId: { type: 'link', entityKey: 'PaymentChannel', inDetail: true, inEdit: true },
        accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true, inEdit: true },
        contactId: { type: 'link', entityKey: 'Contact', inDetail: true, inEdit: true },
        /** Who an outgoing payment went to (§4.12). A customer payment names an account, never both. */
        supplierId: { type: 'link', entityKey: 'Supplier', inList: true, inDetail: true, inEdit: true },
        reference: { type: 'varchar', maxLength: 128, inList: true, inDetail: true, inEdit: true },
        memo: { type: 'text', inDetail: true, inEdit: true },
        status: { type: 'enum', values: ['draft', 'confirmed', 'cancelled'], defaultValue: 'draft', inList: true, inDetail: true, audited: true },
        // Derived from the allocation rows. Never settable by a client: the write guard refuses them.
        allocatedAmount: decimalField({ inList: true, inDetail: true }),
        unallocatedAmount: decimalField({ inList: true, inDetail: true }),
        allocationStatus: { type: 'enum', values: ['unallocated', 'partiallyAllocated', 'allocated'], defaultValue: 'unallocated', inList: true, inDetail: true },
        /**
         * 19-S.18 — the conversion frozen on this money (§4.13). `exchangeRateSnapshot` is the
         * validated JSON the payment command stored, `baseAmount` is `amount` converted at exactly
         * that rate; a payment recorded without a rate has neither, and reporting says so instead of
         * inventing a number. All three are server-written (see `sales-internal.ts`).
         */
        exchangeRateSnapshot: { type: 'text', inDetail: true },
        baseCurrency: { type: 'varchar', maxLength: 3, inDetail: true },
        baseAmount: decimalField({ inDetail: true }),
        baseAllocatedAmount: decimalField({ inDetail: true }),
        baseUnallocatedAmount: decimalField({ inDetail: true }),
      }),
      relations: {
        // What this payment settles, and what it transfers to/from.
        allocations: { type: 'oneToMany', target: 'PaymentAllocation', mappedBy: 'payment' },
        transfersOut: { type: 'oneToMany', target: 'PaymentTransferAllocation', mappedBy: 'fromPayment' },
        transfersIn: { type: 'oneToMany', target: 'PaymentTransferAllocation', mappedBy: 'toPayment' },
      },
      indexes: [
        { name: 'idx_payment_status', fields: ['status'] },
        { name: 'idx_payment_account', fields: ['accountId'] },
        { name: 'idx_payment_supplier', fields: ['supplierId'] },
        { name: 'idx_payment_date', fields: ['paymentDate'] },
      ],
      layouts: {
        list: [{ entity: 'Payment', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'paymentDate', 'direction', 'accountId', 'supplierId', 'amount', 'currency', 'allocationStatus', 'status'] }] }],
        detail: [
          { entity: 'Payment', type: 'detail', panels: [{ name: 'main', label: 'Payment', position: 0, fields: ['name', 'direction', 'status', 'paymentDate', 'accountId', 'contactId', 'supplierId', 'amount', 'currency', 'paymentMethodId', 'paymentChannelId', 'reference', 'memo'] }] },
          { entity: 'Payment', type: 'detail', panels: [{ name: 'allocation', label: 'Allocation', position: 10, fields: ['allocatedAmount', 'unallocatedAmount', 'allocationStatus'] }] },
        ],
        edit: [{ entity: 'Payment', type: 'edit', panels: [{ name: 'main', label: 'Payment', position: 0, fields: ['direction', 'paymentDate', 'accountId', 'contactId', 'supplierId', 'amount', 'currency', 'paymentMethodId', 'paymentChannelId', 'reference', 'memo'] }] }],
      },
      record: { displayField: 'name', removable: false },
      client: {},
      acl: { permissions: { Payment: { create: 'yes', read: 'all', edit: 'yes', delete: 'no', stream: 'all' } } },
    },
  };
}

function salesPaymentAllocationEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'PaymentAllocation',
    data: {
      name: 'PaymentAllocation',
      label: 'Payment Allocation',
      isEntity: true,
      fields: salesFields({
        paymentId: { type: 'link', entityKey: 'Payment', required: true, inList: true, inDetail: true },
        /** The document this allocation settles. `Invoice` today; `Bill` arrives with 19-S.13. */
        documentEntity: { type: 'varchar', maxLength: 64, required: true, inList: true, inDetail: true },
        documentId: { type: 'varchar', maxLength: 64, required: true, inList: true, inDetail: true },
        amount: decimalField({ required: true, inList: true, inDetail: true }),
        currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true },
        allocatedAt: { type: 'datetime', inList: true, inDetail: true },
        allocatedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        correlationId: { type: 'varchar', maxLength: 128, inDetail: true },
        /** 19-S.18 — this allocation at the payment's own frozen rate (§4.13), null without one. */
        baseCurrency: { type: 'varchar', maxLength: 3, inDetail: true },
        baseAmount: decimalField({ inDetail: true }),
      }),
      relations: {},
      indexes: [
        { name: 'idx_payment_allocation_payment', fields: ['paymentId'] },
        { name: 'idx_payment_allocation_document', fields: ['documentId'] },
      ],
      layouts: {
        list: [{ entity: 'PaymentAllocation', type: 'list', panels: [{ name: 'list', position: 0, fields: ['paymentId', 'documentEntity', 'documentId', 'amount', 'currency', 'allocatedAt'] }] }],
        detail: [{ entity: 'PaymentAllocation', type: 'detail', panels: [{ name: 'main', label: 'Allocation', position: 0, fields: ['paymentId', 'documentEntity', 'documentId', 'amount', 'currency', 'allocatedAt', 'allocatedBy'] }] }],
        edit: [],
      },
      // Unallocation *is* a removal in 19-S.10 (the link disappears, both sides recompute), so the
      // record guard must allow the domain command's delete. Credit allocations and write-offs are
      // corrected by reversal instead, which is why theirs stays `false`.
      record: { displayField: 'name', removable: true },
      client: { web: false },
    },
  };
}

function salesPaymentTransferAllocationEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'PaymentTransferAllocation',
    data: {
      name: 'PaymentTransferAllocation',
      label: 'Payment Transfer',
      isEntity: true,
      fields: salesFields({
        fromPaymentId: { type: 'link', entityKey: 'Payment', required: true, inList: true, inDetail: true },
        toPaymentId: { type: 'link', entityKey: 'Payment', required: true, inList: true, inDetail: true },
        amount: decimalField({ required: true, inList: true, inDetail: true }),
        currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true },
        transferredAt: { type: 'datetime', inList: true, inDetail: true },
        transferredBy: { type: 'varchar', maxLength: 64, inDetail: true },
      }),
      relations: {},
      indexes: [
        { name: 'idx_payment_transfer_from', fields: ['fromPaymentId'] },
        { name: 'idx_payment_transfer_to', fields: ['toPaymentId'] },
      ],
      layouts: {
        list: [{ entity: 'PaymentTransferAllocation', type: 'list', panels: [{ name: 'list', position: 0, fields: ['fromPaymentId', 'toPaymentId', 'amount', 'currency', 'transferredAt'] }] }],
        detail: [{ entity: 'PaymentTransferAllocation', type: 'detail', panels: [{ name: 'main', label: 'Transfer', position: 0, fields: ['fromPaymentId', 'toPaymentId', 'amount', 'currency', 'transferredAt', 'transferredBy'] }] }],
        edit: [],
      },
      record: { displayField: 'name', removable: false },
      client: { web: false },
    },
  };
}

function salesPaymentRequestEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'PaymentRequest',
    data: {
      name: 'PaymentRequest',
      label: 'Payment Request',
      isEntity: true,
      fields: salesFields({
        amount: decimalField({ required: true, inList: true, inDetail: true, inEdit: true }),
        currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true, inEdit: true },
        accountId: { type: 'link', entityKey: 'Account', required: true, inList: true, inDetail: true, inEdit: true },
        invoiceId: { type: 'link', entityKey: 'Invoice', inList: true, inDetail: true, inEdit: true },
        salesOrderId: { type: 'link', entityKey: 'SalesOrder', inDetail: true, inEdit: true },
        expiresAt: { type: 'datetime', inDetail: true, inEdit: true },
        /** The provider's own reference once one exists. Never a secret, never card data. */
        providerReference: { type: 'varchar', maxLength: 128, inList: true, inDetail: true },
        status: { type: 'enum', values: ['pending', 'paid', 'failed', 'expired', 'cancelled'], defaultValue: 'pending', inList: true, inDetail: true, audited: true },
      }),
      relations: {},
      indexes: [
        { name: 'idx_payment_request_status', fields: ['status'] },
        { name: 'idx_payment_request_account', fields: ['accountId'] },
      ],
      layouts: {
        list: [{ entity: 'PaymentRequest', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'accountId', 'amount', 'currency', 'status', 'expiresAt'] }] }],
        detail: [{ entity: 'PaymentRequest', type: 'detail', panels: [{ name: 'main', label: 'Payment request', position: 0, fields: ['name', 'accountId', 'invoiceId', 'amount', 'currency', 'status', 'expiresAt', 'providerReference'] }] }],
        edit: [{ entity: 'PaymentRequest', type: 'edit', panels: [{ name: 'main', label: 'Payment request', position: 0, fields: ['accountId', 'invoiceId', 'amount', 'currency', 'expiresAt'] }] }],
      },
      record: { displayField: 'name', removable: false },
      client: {},
    },
  };
}

/**
 * The idempotency log for provider events. `providerEventId` is unique, so a webhook delivered twice
 * finds the existing row instead of settling an invoice twice (§4.8, §6.3). The payload is a summary:
 * card data, mandates and reusable secrets are refused before they reach this row.
 */
function salesPaymentProviderEventLogEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'PaymentProviderEventLog',
    data: {
      name: 'PaymentProviderEventLog',
      label: 'Payment Provider Event',
      isEntity: true,
      fields: salesFields({
        provider: { type: 'varchar', maxLength: 64, required: true, inList: true, inDetail: true },
        providerEventId: { type: 'varchar', maxLength: 191, required: true, inList: true, inDetail: true },
        eventType: { type: 'varchar', maxLength: 128, required: true, inList: true, inDetail: true },
        paymentRequestId: { type: 'link', entityKey: 'PaymentRequest', inList: true, inDetail: true },
        payload: { type: 'text', inDetail: true },
        processedStatus: { type: 'enum', values: ['received', 'processed', 'ignored'], defaultValue: 'received', inList: true, inDetail: true },
        processedAt: { type: 'datetime', inList: true, inDetail: true },
      }),
      relations: {},
      indexes: [
        { name: 'idx_payment_provider_event_id', fields: ['providerEventId'] },
        { name: 'idx_payment_provider_event_request', fields: ['paymentRequestId'] },
      ],
      layouts: {
        list: [{ entity: 'PaymentProviderEventLog', type: 'list', panels: [{ name: 'list', position: 0, fields: ['provider', 'eventType', 'processedStatus', 'processedAt'] }] }],
        detail: [{ entity: 'PaymentProviderEventLog', type: 'detail', panels: [{ name: 'main', label: 'Provider event', position: 0, fields: ['provider', 'providerEventId', 'eventType', 'paymentRequestId', 'processedStatus', 'processedAt', 'payload'] }] }],
        edit: [],
      },
      record: { displayField: 'name', removable: false },
      client: { web: false },
    },
  };
}

/** A credit note applied to an invoice — the record that reduces a receivable (§4.9). */
function salesCreditNoteAllocationEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'CreditNoteAllocation',
    data: {
      name: 'CreditNoteAllocation',
      label: 'Credit Note Allocation',
      isEntity: true,
      fields: salesFields({
        creditNoteId: { type: 'link', entityKey: 'CreditNote', required: true, inList: true, inDetail: true },
        invoiceId: { type: 'link', entityKey: 'Invoice', required: true, inList: true, inDetail: true },
        amount: decimalField({ required: true, inList: true, inDetail: true }),
        currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true },
        allocatedAt: { type: 'datetime', inList: true, inDetail: true },
        allocatedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        reversedAt: { type: 'datetime', inDetail: true },
        reversedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        reversalReason: { type: 'varchar', maxLength: 255, inDetail: true },
        /** 19-S.18 — this credit applied at the credit note's own frozen rate (§4.13), null without one. */
        baseCurrency: { type: 'varchar', maxLength: 3, inDetail: true },
        baseAmount: decimalField({ inDetail: true }),
      }),
      relations: {},
      indexes: [
        { name: 'idx_credit_note_allocation_note', fields: ['creditNoteId'] },
        { name: 'idx_credit_note_allocation_invoice', fields: ['invoiceId'] },
      ],
      layouts: {
        list: [{ entity: 'CreditNoteAllocation', type: 'list', panels: [{ name: 'list', position: 0, fields: ['creditNoteId', 'invoiceId', 'amount', 'currency', 'allocatedAt'] }] }],
        detail: [{ entity: 'CreditNoteAllocation', type: 'detail', panels: [{ name: 'main', label: 'Credit allocation', position: 0, fields: ['creditNoteId', 'invoiceId', 'amount', 'currency', 'allocatedAt', 'allocatedBy', 'reversedAt', 'reversalReason'] }] }],
        edit: [],
      },
      record: { displayField: 'name', removable: false },
      client: { web: false },
    },
  };
}

/** An approved balance adjustment. Never disguised as a payment (§4.9). */
function salesWriteOffEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'WriteOff',
    data: {
      name: 'WriteOff',
      label: 'Write-off',
      isEntity: true,
      fields: salesFields({
        invoiceId: { type: 'link', entityKey: 'Invoice', required: true, inList: true, inDetail: true, inEdit: true },
        amount: decimalField({ required: true, inList: true, inDetail: true, inEdit: true }),
        currency: { type: 'varchar', maxLength: 3, inList: true, inDetail: true, inEdit: true },
        reason: { type: 'varchar', maxLength: 255, required: true, inDetail: true, inEdit: true },
        /** `pending` is a request; only `approved` reduces the invoice. `reversed` compensates an approval. */
        status: { type: 'enum', values: ['pending', 'approved', 'rejected', 'reversed'], defaultValue: 'pending', inList: true, inDetail: true, audited: true },
        requestedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        approvedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        approvedAt: { type: 'datetime', inList: true, inDetail: true },
        reversedBy: { type: 'varchar', maxLength: 64, inDetail: true },
        reversedAt: { type: 'datetime', inDetail: true },
        reversalReason: { type: 'varchar', maxLength: 255, inDetail: true },
        /** 19-S.18 — this forgiveness at the invoice's own frozen rate (§4.13), null without one. */
        baseCurrency: { type: 'varchar', maxLength: 3, inDetail: true },
        baseAmount: decimalField({ inDetail: true }),
      }),
      relations: {},
      indexes: [
        { name: 'idx_write_off_invoice', fields: ['invoiceId'] },
        { name: 'idx_write_off_status', fields: ['status'] },
      ],
      layouts: {
        list: [{ entity: 'WriteOff', type: 'list', panels: [{ name: 'list', position: 0, fields: ['invoiceId', 'amount', 'currency', 'status', 'approvedAt'] }] }],
        detail: [{ entity: 'WriteOff', type: 'detail', panels: [{ name: 'main', label: 'Write-off', position: 0, fields: ['invoiceId', 'amount', 'currency', 'reason', 'status', 'requestedBy', 'approvedBy', 'approvedAt', 'reversedAt', 'reversalReason'] }] }],
        edit: [{ entity: 'WriteOff', type: 'edit', panels: [{ name: 'main', label: 'Write-off', position: 0, fields: ['invoiceId', 'amount', 'currency', 'reason'] }] }],
      },
      record: { displayField: 'name', removable: false },
      client: {},
      // A write-off is *requested* through the record or the command; approval, rejection and
      // reversal are domain commands (administrator-gated), and never disguised as an edit.
      acl: { permissions: { WriteOff: { create: 'yes', read: 'all', edit: 'yes', delete: 'no', stream: 'all' } } },
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 19-CS — Customer Success entities (PLAN_Phase_19_Customer_Success.md §6)
//
// Every Customer Success record lives in the generic `entity_records` store like any other CRM
// entity, so the Entity Engine provides CRUD, field validation, audit, stream, attachments and record
// ACL for free. The relational invariants JSON alone cannot express — one active profile per account,
// a run's trigger idempotency key — are expression indexes in migration `032`.
// ---------------------------------------------------------------------------

/** Fields shared by every Customer Success entity, with the audit flags this module needs. */
function csFields(extra: Record<string, Record<string, unknown>> = {}): Record<string, Record<string, unknown>> {
  return {
    ...standardFields,
    name: { ...standardFields['name'], required: true, audited: true },
    ...extra,
  };
}

function customerSuccessEntities(): MetadataSeedEntry[] {
  return [
    {
      scope: 'entity',
      name: 'CustomerSuccessProfile',
      data: {
        name: 'CustomerSuccessProfile',
        label: 'Customer Success Profile',
        isEntity: true,
        fields: csFields({
          /** The authoritative customer record this profile is about (§5.1); unique while active. */
          accountId: { type: 'link', entityKey: 'Account', required: true, inList: true, inDetail: true, inEdit: true },
          csmUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true, inEdit: true, audited: true },
          csmTeamId: { type: 'link', entityKey: 'Team', inList: true, inDetail: true, inEdit: true },
          lifecycleStage: { type: 'enum', values: CS_LIFECYCLE_STAGES, defaultValue: 'onboarding', inList: true, inDetail: true, inEdit: true, audited: true },
          lifecycleStageReason: { type: 'text', inDetail: true, audited: true },
          lifecycleStageChangedAt: { type: 'datetime', inDetail: true },
          /** Effective status (override-aware); `calculatedHealthStatus` is the engine's own result. */
          healthStatus: { type: 'enum', values: CS_HEALTH_STATUSES, defaultValue: 'unknown', inList: true, inDetail: true, sortable: true },
          calculatedHealthStatus: { type: 'enum', values: CS_HEALTH_STATUSES, defaultValue: 'unknown', inDetail: true },
          healthScore: { type: 'int', inList: true, inDetail: true, sortable: true },
          healthScoreAt: { type: 'datetime', inDetail: true },
          healthOverride: { type: 'enum', values: CS_HEALTH_OVERRIDES, inDetail: true },
          healthOverrideReason: { type: 'text', inDetail: true },
          healthOverrideByUserId: { type: 'link', entityKey: 'User', inDetail: true },
          healthOverrideAt: { type: 'datetime', inDetail: true },
          healthOverrideExpiresAt: { type: 'date', inDetail: true },
          scoreTrend: { type: 'enum', values: CS_TRENDS, defaultValue: 'unknown', inList: true, inDetail: true },
          segment: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
          onboardingStatus: { type: 'enum', values: CS_ONBOARDING_STATUSES, defaultValue: 'notStarted', inList: true, inDetail: true },
          onboardingStartedAt: { type: 'date', inDetail: true },
          onboardingTargetDate: { type: 'date', inList: true, inDetail: true, inEdit: true },
          onboardingCompletedAt: { type: 'date', inDetail: true },
          activePlaybookRunId: { type: 'link', entityKey: 'CustomerSuccessPlaybookRun', inDetail: true },
          renewalDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
          renewalStatus: { type: 'enum', values: CS_RENEWAL_STATUSES, defaultValue: 'unknown', inList: true, inDetail: true, inEdit: true },
          renewalSource: { type: 'varchar', maxLength: 32, inDetail: true },
          renewalSyncedAt: { type: 'datetime', inDetail: true },
          notifiedRenewalWindows: { type: 'text', inDetail: true },
          lastMeaningfulTouchAt: { type: 'datetime', inList: true, inDetail: true },
          nextSuccessReviewAt: { type: 'datetime', inList: true, inDetail: true, inEdit: true, sortable: true },
          lastHealthReviewAt: { type: 'datetime', inDetail: true },
          customerSince: { type: 'date', inDetail: true, inEdit: true },
          executiveSponsorContactId: { type: 'link', entityKey: 'Contact', inDetail: true, inEdit: true },
          primaryPlanId: { type: 'link', entityKey: 'CustomerSuccessPlan', inList: true, inDetail: true },
          activePlanProgress: { type: 'int', inList: true, inDetail: true },
          openRiskCount: { type: 'int', inList: true, inDetail: true },
        }),
        relations: {
          plans: { type: 'oneToMany', target: 'CustomerSuccessPlan', mappedBy: 'profile' },
          goals: { type: 'oneToMany', target: 'CustomerSuccessGoal', mappedBy: 'profile' },
          risks: { type: 'oneToMany', target: 'CustomerSuccessRisk', mappedBy: 'profile' },
          snapshots: { type: 'oneToMany', target: 'CustomerSuccessHealthSnapshot', mappedBy: 'profile' },
          playbookRuns: { type: 'oneToMany', target: 'CustomerSuccessPlaybookRun', mappedBy: 'profile' },
          reviews: { type: 'oneToMany', target: 'CustomerSuccessReview', mappedBy: 'profile' },
          contacts: { type: 'manyMany', target: 'Contact' },
        },
        indexes: [
          { name: 'idx_cs_profile_account', fields: ['accountId'] },
          { name: 'idx_cs_profile_csm', fields: ['csmUserId'] },
          { name: 'idx_cs_profile_health', fields: ['healthStatus'] },
        ],
        layouts: {
          list: [{ entity: 'CustomerSuccessProfile', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'accountId', 'csmUserId', 'lifecycleStage', 'healthStatus', 'healthScore', 'renewalDate', 'openRiskCount'] }] }],
          detail: [
            {
              entity: 'CustomerSuccessProfile',
              type: 'detail',
              panels: [
                { name: 'overview', label: 'Overview', position: 0, fields: ['name', 'accountId', 'csmUserId', 'csmTeamId', 'segment', 'lifecycleStage', 'customerSince'] },
                { name: 'health', label: 'Health', position: 10, fields: ['healthStatus', 'calculatedHealthStatus', 'healthScore', 'healthScoreAt', 'scoreTrend', 'healthOverride', 'healthOverrideReason', 'healthOverrideExpiresAt'] },
                { name: 'onboarding', label: 'Onboarding', position: 20, fields: ['onboardingStatus', 'onboardingStartedAt', 'onboardingTargetDate', 'onboardingCompletedAt', 'activePlaybookRunId'] },
                { name: 'renewal', label: 'Renewal', position: 30, fields: ['renewalDate', 'renewalStatus', 'renewalSource', 'renewalSyncedAt'] },
                { name: 'portfolio', label: 'Portfolio', position: 40, fields: ['activePlanProgress', 'openRiskCount', 'lastMeaningfulTouchAt', 'nextSuccessReviewAt'] },
              ],
            },
          ],
          edit: [
            {
              entity: 'CustomerSuccessProfile',
              type: 'edit',
              panels: [
                { name: 'main', label: 'Profile', position: 0, fields: ['name', 'accountId', 'csmUserId', 'csmTeamId', 'segment', 'lifecycleStage', 'customerSince', 'executiveSponsorContactId', 'nextSuccessReviewAt', 'renewalDate', 'renewalStatus', 'onboardingTargetDate'] },
              ],
            },
          ],
        },
        record: { displayField: 'name', removable: true, followable: true, streamable: true },
        client: {},
        acl: { permissions: { CustomerSuccessProfile: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } } },
      },
    },
    {
      scope: 'entity',
      name: 'CustomerSuccessHealthSnapshot',
      data: {
        name: 'CustomerSuccessHealthSnapshot',
        label: 'Customer Success Health Snapshot',
        isEntity: true,
        fields: csFields({
          profileId: { type: 'link', entityKey: 'CustomerSuccessProfile', required: true, inList: true, inDetail: true },
          accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true },
          score: { type: 'int', inList: true, inDetail: true, sortable: true },
          status: { type: 'enum', values: CS_HEALTH_STATUSES, defaultValue: 'unknown', inList: true, inDetail: true, audited: true },
          effectiveStatus: { type: 'enum', values: CS_HEALTH_STATUSES, defaultValue: 'unknown', inList: true, inDetail: true },
          coverage: { type: 'float', inDetail: true },
          configurationVersion: { type: 'int', inDetail: true },
          source: { type: 'enum', values: ['manual', 'scheduled', 'event', 'rebuild'], defaultValue: 'manual', inList: true, inDetail: true },
          resultState: { type: 'enum', values: ['success', 'partial', 'failed'], defaultValue: 'success', inList: true, inDetail: true },
          errorSummary: { type: 'text', inDetail: true },
          durationMs: { type: 'int', inDetail: true },
          components: { type: 'text', inDetail: true },
          signature: { type: 'text', inDetail: true },
          triggerReason: { type: 'varchar', maxLength: 255, inDetail: true },
          idempotencyKey: { type: 'varchar', maxLength: 128, inDetail: true },
          calculatedAt: { type: 'datetime', inList: true, inDetail: true, sortable: true },
        }),
        relations: {},
        indexes: [
          { name: 'idx_cs_snapshot_profile', fields: ['profileId'] },
          { name: 'idx_cs_snapshot_calculated', fields: ['calculatedAt'] },
        ],
        layouts: {
          list: [{ entity: 'CustomerSuccessHealthSnapshot', type: 'list', panels: [{ name: 'list', position: 0, fields: ['profileId', 'score', 'status', 'effectiveStatus', 'coverage', 'configurationVersion', 'source', 'calculatedAt'] }] }],
          detail: [{ entity: 'CustomerSuccessHealthSnapshot', type: 'detail', panels: [{ name: 'main', label: 'Snapshot', position: 0, fields: ['profileId', 'accountId', 'score', 'status', 'effectiveStatus', 'coverage', 'configurationVersion', 'source', 'resultState', 'durationMs', 'calculatedAt', 'components'] }] }],
          edit: [],
        },
        record: { displayField: 'name', removable: false },
        client: { web: false },
        // Append-only and module-written. Read/edit/delete are closed at the ACL level as well as by
        // the write guard, and the history is served through a profile-scoped command instead (§5.4.4).
        acl: { permissions: { CustomerSuccessHealthSnapshot: { create: 'yes', read: 'no', edit: 'no', delete: 'no', stream: 'no' } } },
      },
    },
    {
      scope: 'entity',
      name: 'CustomerSuccessPlan',
      data: {
        name: 'CustomerSuccessPlan',
        label: 'Customer Success Plan',
        isEntity: true,
        fields: csFields({
          profileId: { type: 'link', entityKey: 'CustomerSuccessProfile', required: true, inList: true, inDetail: true, inEdit: true },
          accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true },
          ownerUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true, inEdit: true },
          status: { type: 'enum', values: CS_PLAN_STATUSES, defaultValue: 'draft', inList: true, inDetail: true, sortable: true },
          isPrimary: { type: 'bool', defaultValue: false, inList: true, inDetail: true },
          planType: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
          startDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
          endDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
          nextReviewDate: { type: 'date', inDetail: true, inEdit: true },
          completedDate: { type: 'date', inDetail: true },
          closeOutSummary: { type: 'text', inDetail: true },
          outcomes: { type: 'text', inDetail: true, inEdit: true },
          baselineSummary: { type: 'text', inDetail: true, inEdit: true },
          progress: { type: 'int', inList: true, inDetail: true },
          executiveSponsorContactId: { type: 'link', entityKey: 'Contact', inDetail: true, inEdit: true },
          projectId: { type: 'link', entityKey: 'Project', inDetail: true, inEdit: true },
          contactIds: { type: 'linkMultiple', entityKey: 'Contact', inDetail: true, inEdit: true },
          opportunityId: { type: 'link', entityKey: 'Opportunity', inDetail: true, inEdit: true },
        }),
        relations: {
          goals: { type: 'oneToMany', target: 'CustomerSuccessGoal', mappedBy: 'plan' },
          risks: { type: 'oneToMany', target: 'CustomerSuccessRisk', mappedBy: 'plan' },
        },
        indexes: [
          { name: 'idx_cs_plan_profile', fields: ['profileId', 'status'] },
        ],
        layouts: {
          list: [{ entity: 'CustomerSuccessPlan', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'profileId', 'status', 'progress', 'startDate', 'endDate', 'ownerUserId'] }] }],
          detail: [
            {
              entity: 'CustomerSuccessPlan',
              type: 'detail',
              panels: [
                { name: 'overview', label: 'Overview', position: 0, fields: ['name', 'profileId', 'accountId', 'status', 'isPrimary', 'planType', 'progress'] },
                { name: 'timeframe', label: 'Timeframe', position: 10, fields: ['startDate', 'endDate', 'nextReviewDate', 'completedDate'] },
                { name: 'content', label: 'Content', position: 20, fields: ['outcomes', 'baselineSummary', 'closeOutSummary', 'executiveSponsorContactId', 'projectId'] },
              ],
            },
          ],
          edit: [{ entity: 'CustomerSuccessPlan', type: 'edit', panels: [{ name: 'main', label: 'Plan', position: 0, fields: ['name', 'profileId', 'planType', 'ownerUserId', 'startDate', 'endDate', 'nextReviewDate', 'outcomes', 'baselineSummary', 'executiveSponsorContactId', 'projectId'] }] }],
        },
        record: { displayField: 'name', removable: true, streamable: true },
        client: {},
        acl: { permissions: { CustomerSuccessPlan: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } } },
      },
    },
    {
      scope: 'entity',
      name: 'CustomerSuccessGoal',
      data: {
        name: 'CustomerSuccessGoal',
        label: 'Customer Success Goal',
        isEntity: true,
        fields: csFields({
          planId: { type: 'link', entityKey: 'CustomerSuccessPlan', required: true, inList: true, inDetail: true, inEdit: true },
          profileId: { type: 'link', entityKey: 'CustomerSuccessProfile', inList: true, inDetail: true },
          accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true },
          direction: { type: 'enum', values: CS_GOAL_DIRECTIONS, defaultValue: 'manual', inList: true, inDetail: true, inEdit: true },
          category: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
          baselineValue: { type: 'float', inDetail: true, inEdit: true },
          baselineDate: { type: 'date', inDetail: true, inEdit: true },
          targetValue: { type: 'float', inDetail: true, inEdit: true },
          targetDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
          currentValue: { type: 'float', inList: true, inDetail: true },
          currentDate: { type: 'date', inDetail: true },
          unit: { type: 'varchar', maxLength: 32, inDetail: true, inEdit: true },
          tolerance: { type: 'float', inDetail: true, inEdit: true },
          status: { type: 'enum', values: CS_GOAL_STATUSES, defaultValue: 'notStarted', inList: true, inDetail: true, sortable: true },
          progress: { type: 'int', inList: true, inDetail: true, sortable: true },
          progressAt: { type: 'datetime', inDetail: true },
          progressExplanation: { type: 'text', inDetail: true },
          overdue: { type: 'bool', defaultValue: false, inList: true, inDetail: true },
          checkpointNotes: { type: 'text', inDetail: true },
          ownerUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true, inEdit: true },
          contactId: { type: 'link', entityKey: 'Contact', inDetail: true, inEdit: true },
        }),
        relations: {},
        indexes: [
          { name: 'idx_cs_goal_plan', fields: ['planId', 'status'] },
          { name: 'idx_cs_goal_due', fields: ['targetDate'] },
        ],
        layouts: {
          list: [{ entity: 'CustomerSuccessGoal', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'planId', 'direction', 'status', 'progress', 'currentValue', 'targetValue', 'targetDate'] }] }],
          detail: [{ entity: 'CustomerSuccessGoal', type: 'detail', panels: [{ name: 'main', label: 'Goal', position: 0, fields: ['name', 'description', 'planId', 'profileId', 'category', 'direction', 'unit', 'status', 'progress', 'progressExplanation'] }, { name: 'measurement', label: 'Measurement', position: 10, fields: ['baselineValue', 'baselineDate', 'targetValue', 'targetDate', 'currentValue', 'currentDate', 'tolerance', 'overdue'] }, { name: 'ownership', label: 'Ownership', position: 20, fields: ['ownerUserId', 'contactId', 'checkpointNotes'] }] }],
          edit: [{ entity: 'CustomerSuccessGoal', type: 'edit', panels: [{ name: 'main', label: 'Goal', position: 0, fields: ['name', 'description', 'planId', 'category', 'direction', 'unit', 'baselineValue', 'baselineDate', 'targetValue', 'targetDate', 'tolerance', 'ownerUserId', 'contactId'] }] }],
        },
        record: { displayField: 'name', removable: true, streamable: true },
        client: {},
        acl: { permissions: { CustomerSuccessGoal: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } } },
      },
    },
    {
      scope: 'entity',
      name: 'CustomerSuccessRisk',
      data: {
        name: 'CustomerSuccessRisk',
        label: 'Customer Success Risk',
        isEntity: true,
        fields: csFields({
          profileId: { type: 'link', entityKey: 'CustomerSuccessProfile', required: true, inList: true, inDetail: true, inEdit: true },
          accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true },
          planId: { type: 'link', entityKey: 'CustomerSuccessPlan', inDetail: true, inEdit: true },
          riskType: { type: 'enum', values: CS_RISK_TYPES, defaultValue: 'unknown', inList: true, inDetail: true, inEdit: true },
          severity: { type: 'enum', values: CS_RISK_SEVERITIES, defaultValue: 'medium', inList: true, inDetail: true, inEdit: true, sortable: true, audited: true },
          status: { type: 'enum', values: CS_RISK_STATUSES, defaultValue: 'open', inList: true, inDetail: true, sortable: true, audited: true },
          ownerUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true, inEdit: true },
          escalationTeamId: { type: 'link', entityKey: 'Team', inDetail: true, inEdit: true },
          contactId: { type: 'link', entityKey: 'Contact', inDetail: true, inEdit: true },
          opportunityId: { type: 'link', entityKey: 'Opportunity', inDetail: true, inEdit: true },
          subscriptionId: { type: 'link', entityKey: 'Subscription', inDetail: true, inEdit: true },
          detectedDate: { type: 'date', inDetail: true },
          nextReviewDate: { type: 'date', inList: true, inDetail: true, inEdit: true },
          targetResolutionDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
          resolvedDate: { type: 'date', inDetail: true },
          evidenceSummary: { type: 'text', inDetail: true, inEdit: true },
          mitigationPlan: { type: 'text', inDetail: true, inEdit: true },
          nextAction: { type: 'text', inDetail: true, inEdit: true },
          resolutionReason: { type: 'text', inDetail: true },
          resolutionHistory: { type: 'text', inDetail: true },
          contributesToHealth: { type: 'bool', defaultValue: true, inDetail: true, inEdit: true },
          probability: { type: 'int', inDetail: true, inEdit: true },
          impact: { type: 'int', inDetail: true, inEdit: true },
        }),
        relations: {},
        indexes: [
          { name: 'idx_cs_risk_profile', fields: ['profileId', 'status'] },
          { name: 'idx_cs_risk_severity', fields: ['severity', 'status'] },
        ],
        layouts: {
          list: [{ entity: 'CustomerSuccessRisk', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'profileId', 'riskType', 'severity', 'status', 'ownerUserId', 'targetResolutionDate'] }] }],
          detail: [
            {
              entity: 'CustomerSuccessRisk',
              type: 'detail',
              panels: [
                { name: 'main', label: 'Risk', position: 0, fields: ['name', 'description', 'profileId', 'accountId', 'planId', 'riskType', 'severity', 'status', 'probability', 'impact'] },
                { name: 'mitigation', label: 'Mitigation', position: 10, fields: ['ownerUserId', 'escalationTeamId', 'evidenceSummary', 'mitigationPlan', 'nextAction'] },
                { name: 'dates', label: 'Dates', position: 20, fields: ['detectedDate', 'nextReviewDate', 'targetResolutionDate', 'resolvedDate', 'resolutionReason', 'contributesToHealth'] },
              ],
            },
          ],
          edit: [{ entity: 'CustomerSuccessRisk', type: 'edit', panels: [{ name: 'main', label: 'Risk', position: 0, fields: ['name', 'description', 'profileId', 'planId', 'riskType', 'severity', 'ownerUserId', 'escalationTeamId', 'evidenceSummary', 'mitigationPlan', 'nextAction', 'targetResolutionDate', 'nextReviewDate', 'contributesToHealth'] }] }],
        },
        record: { displayField: 'name', removable: true, streamable: true },
        client: {},
        acl: { permissions: { CustomerSuccessRisk: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } } },
      },
    },
    {
      scope: 'entity',
      name: 'CustomerSuccessPlaybookTemplate',
      data: {
        name: 'CustomerSuccessPlaybookTemplate',
        label: 'Customer Success Playbook Template',
        isEntity: true,
        fields: csFields({
          playbookType: { type: 'varchar', maxLength: 64, defaultValue: 'custom', inList: true, inDetail: true, inEdit: true },
          triggerMode: { type: 'enum', values: CS_PLAYBOOK_TRIGGERS, defaultValue: 'manual', inList: true, inDetail: true, inEdit: true },
          triggerConfig: { type: 'text', inDetail: true, inEdit: true },
          isActive: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
          version: { type: 'int', defaultValue: 1, inList: true, inDetail: true },
          steps: { type: 'text', inDetail: true },
        }),
        relations: { runs: { type: 'oneToMany', target: 'CustomerSuccessPlaybookRun', mappedBy: 'template' } },
        indexes: [{ name: 'idx_cs_playbook_type', fields: ['playbookType'] }],
        layouts: {
          list: [{ entity: 'CustomerSuccessPlaybookTemplate', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'playbookType', 'triggerMode', 'isActive', 'version'] }] }],
          detail: [{ entity: 'CustomerSuccessPlaybookTemplate', type: 'detail', panels: [{ name: 'main', label: 'Template', position: 0, fields: ['name', 'description', 'playbookType', 'triggerMode', 'triggerConfig', 'isActive', 'version', 'steps'] }] }],
          edit: [{ entity: 'CustomerSuccessPlaybookTemplate', type: 'edit', panels: [{ name: 'main', label: 'Template', position: 0, fields: ['name', 'description', 'playbookType', 'triggerMode', 'isActive'] }] }],
        },
        record: { displayField: 'name', removable: true },
        client: {},
        // Steps are validated configuration: they are written only by the template command, so a role
        // needs `create`/`edit` here to author a template but cannot hand-write raw steps.
        acl: { permissions: { CustomerSuccessPlaybookTemplate: { create: 'yes', read: 'all', edit: 'yes', delete: 'no', stream: 'all' } } },
      },
    },
    {
      scope: 'entity',
      name: 'CustomerSuccessPlaybookRun',
      data: {
        name: 'CustomerSuccessPlaybookRun',
        label: 'Customer Success Playbook Run',
        isEntity: true,
        fields: csFields({
          profileId: { type: 'link', entityKey: 'CustomerSuccessProfile', required: true, inList: true, inDetail: true },
          accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true },
          templateId: { type: 'link', entityKey: 'CustomerSuccessPlaybookTemplate', inList: true, inDetail: true },
          templateVersion: { type: 'int', inDetail: true },
          status: { type: 'enum', values: CS_RUN_STATUSES, defaultValue: 'running', inList: true, inDetail: true, sortable: true },
          onboarding: { type: 'bool', defaultValue: false, inList: true, inDetail: true },
          startedAt: { type: 'datetime', inList: true, inDetail: true },
          completedAt: { type: 'datetime', inDetail: true },
          canceledAt: { type: 'datetime', inDetail: true },
          cancelReason: { type: 'text', inDetail: true },
          triggerSource: { type: 'varchar', maxLength: 64, inList: true, inDetail: true },
          triggerKey: { type: 'varchar', maxLength: 192, inDetail: true },
          stepSnapshot: { type: 'text', inDetail: true },
          stepCount: { type: 'int', inList: true, inDetail: true },
          completedStepCount: { type: 'int', inList: true, inDetail: true },
          errorSummary: { type: 'text', inDetail: true },
        }),
        relations: { steps: { type: 'oneToMany', target: 'CustomerSuccessPlaybookStepRun', mappedBy: 'run' } },
        indexes: [
          { name: 'idx_cs_run_profile', fields: ['profileId', 'status'] },
          { name: 'idx_cs_run_trigger', fields: ['triggerKey'] },
        ],
        layouts: {
          list: [{ entity: 'CustomerSuccessPlaybookRun', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'profileId', 'templateId', 'status', 'onboarding', 'completedStepCount', 'stepCount', 'startedAt'] }] }],
          detail: [{ entity: 'CustomerSuccessPlaybookRun', type: 'detail', panels: [{ name: 'main', label: 'Run', position: 0, fields: ['name', 'profileId', 'accountId', 'templateId', 'templateVersion', 'status', 'onboarding', 'triggerSource', 'startedAt', 'completedAt', 'canceledAt', 'cancelReason', 'completedStepCount', 'stepCount'] }] }],
          edit: [],
        },
        record: { displayField: 'name', removable: false },
        client: {},
        acl: { permissions: { CustomerSuccessPlaybookRun: { create: 'yes', read: 'all', edit: 'own', delete: 'no', stream: 'own' } } },
      },
    },
    {
      scope: 'entity',
      name: 'CustomerSuccessPlaybookStepRun',
      data: {
        name: 'CustomerSuccessPlaybookStepRun',
        label: 'Customer Success Playbook Step Run',
        isEntity: true,
        fields: csFields({
          runId: { type: 'link', entityKey: 'CustomerSuccessPlaybookRun', required: true, inList: true, inDetail: true },
          profileId: { type: 'link', entityKey: 'CustomerSuccessProfile', inList: true, inDetail: true },
          accountId: { type: 'link', entityKey: 'Account', inDetail: true },
          stepKey: { type: 'varchar', maxLength: 64, inList: true, inDetail: true },
          stepOrder: { type: 'int', inList: true, inDetail: true, sortable: true },
          stepType: { type: 'enum', values: CS_PLAYBOOK_STEP_TYPES, defaultValue: 'manual', inList: true, inDetail: true },
          status: { type: 'enum', values: CS_STEP_RUN_STATUSES, defaultValue: 'pending', inList: true, inDetail: true, sortable: true },
          isRequired: { type: 'bool', defaultValue: true, inList: true, inDetail: true },
          dependsOn: { type: 'text', inDetail: true },
          dueDate: { type: 'date', inList: true, inDetail: true, sortable: true },
          assigneeUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true },
          linkedEntityType: { type: 'varchar', maxLength: 64, inDetail: true },
          linkedEntityId: { type: 'varchar', maxLength: 64, inDetail: true },
          completedAt: { type: 'datetime', inDetail: true },
          completionNote: { type: 'text', inDetail: true },
          skipReason: { type: 'text', inDetail: true },
          errorSummary: { type: 'text', inDetail: true },
          attemptCount: { type: 'int', defaultValue: 0, inDetail: true },
          waitUntil: { type: 'date', inDetail: true },
          instructions: { type: 'text', inDetail: true },
        }),
        relations: {},
        indexes: [
          { name: 'idx_cs_step_run', fields: ['runId', 'status'] },
          { name: 'idx_cs_step_assignee', fields: ['assigneeUserId', 'status'] },
        ],
        layouts: {
          list: [{ entity: 'CustomerSuccessPlaybookStepRun', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'runId', 'stepType', 'status', 'isRequired', 'dueDate', 'assigneeUserId'] }] }],
          detail: [{ entity: 'CustomerSuccessPlaybookStepRun', type: 'detail', panels: [{ name: 'main', label: 'Step', position: 0, fields: ['name', 'runId', 'stepKey', 'stepOrder', 'stepType', 'status', 'isRequired', 'dependsOn', 'dueDate', 'assigneeUserId', 'linkedEntityType', 'linkedEntityId', 'completedAt', 'completionNote', 'errorSummary', 'skipReason', 'waitUntil', 'instructions'] }] }],
          edit: [],
        },
        record: { displayField: 'name', removable: false },
        client: {},
        acl: { permissions: { CustomerSuccessPlaybookStepRun: { create: 'yes', read: 'all', edit: 'own', delete: 'no', stream: 'own' } } },
      },
    },
    {
      scope: 'entity',
      name: 'CustomerSuccessReview',
      data: {
        name: 'CustomerSuccessReview',
        label: 'Customer Success Review',
        isEntity: true,
        fields: csFields({
          profileId: { type: 'link', entityKey: 'CustomerSuccessProfile', required: true, inList: true, inDetail: true, inEdit: true },
          accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true },
          activityType: { type: 'enum', values: CS_ACTIVITY_TYPES, defaultValue: 'Meeting', inList: true, inDetail: true },
          activityId: { type: 'varchar', maxLength: 64, inList: true, inDetail: true },
          reviewDate: { type: 'date', inList: true, inDetail: true, inEdit: true, sortable: true },
          sentiment: { type: 'enum', values: CS_SENTIMENTS, defaultValue: 'unknown', inList: true, inDetail: true, inEdit: true },
          objectives: { type: 'text', inDetail: true, inEdit: true },
          outcomes: { type: 'text', inDetail: true, inEdit: true },
          openRisks: { type: 'text', inDetail: true, inEdit: true },
          goalProgressNote: { type: 'text', inDetail: true, inEdit: true },
          actionItems: { type: 'text', inDetail: true, inEdit: true },
          nextReviewDate: { type: 'date', inList: true, inDetail: true, inEdit: true },
          ownerUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true, inEdit: true },
          contactIds: { type: 'linkMultiple', entityKey: 'Contact', inDetail: true, inEdit: true },
        }),
        relations: {},
        indexes: [
          { name: 'idx_cs_review_profile', fields: ['profileId', 'reviewDate'] },
          { name: 'idx_cs_review_activity', fields: ['activityId'] },
        ],
        layouts: {
          list: [{ entity: 'CustomerSuccessReview', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'profileId', 'activityType', 'reviewDate', 'sentiment', 'nextReviewDate'] }] }],
          detail: [{ entity: 'CustomerSuccessReview', type: 'detail', panels: [{ name: 'main', label: 'Review', position: 0, fields: ['name', 'profileId', 'accountId', 'activityType', 'activityId', 'reviewDate', 'sentiment'] }, { name: 'content', label: 'Content', position: 10, fields: ['objectives', 'outcomes', 'openRisks', 'goalProgressNote', 'actionItems', 'nextReviewDate', 'ownerUserId'] }] }],
          edit: [{ entity: 'CustomerSuccessReview', type: 'edit', panels: [{ name: 'main', label: 'Review', position: 0, fields: ['name', 'profileId', 'reviewDate', 'sentiment', 'objectives', 'outcomes', 'openRisks', 'goalProgressNote', 'actionItems', 'nextReviewDate', 'ownerUserId'] }] }],
        },
        record: { displayField: 'name', removable: true, streamable: true },
        client: {},
        acl: { permissions: { CustomerSuccessReview: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } } },
      },
    },
  ];
}

/**
 * Phase 19-SD.2 / 19-SD.3 — the canonical `Case` entity (PLAN_Phase_19_ServiceDesk.md §5.1, §6.1).
 *
 * `name` is the case subject: the record's display field IS the subject, exactly as the `Email`
 * entity's display name is its subject, so lists, search and stream posts read what an agent
 * recognises without a second label. `caseNumber` is allocated by the module (never typed in), and
 * the timing, SLA and escalation fields are server-owned — the `beforeValidate` write guard refuses
 * a client write that sets any of them, and a Service Desk domain service sets them under its
 * internal marker.
 */
function serviceDeskCaseEntity(): MetadataSeedEntry {
  return {
    scope: 'entity',
    name: 'Case',
    data: {
      name: 'Case',
      label: 'Case',
      isEntity: true,
      fields: {
        ...standardFields,
        // Identity and content.
        name: { ...standardFields.name, label: 'Subject', required: true, maxLength: 255, audited: true },
        caseNumber: { type: 'varchar', maxLength: 32, inList: true, inDetail: true, sortable: true, audited: true },
        description: { type: 'text', inDetail: true, inEdit: true },
        // Classification (§5.1). Enums are configurable through metadata overrides.
        status: { type: 'enum', values: SD_CASE_STATUSES, defaultValue: 'New', inList: true, inDetail: true, inEdit: true, audited: true },
        priority: { type: 'enum', values: SD_CASE_PRIORITIES, defaultValue: 'Normal', inList: true, inDetail: true, inEdit: true, audited: true },
        severity: { type: 'enum', values: SD_CASE_SEVERITIES, defaultValue: 'Normal', inDetail: true, inEdit: true, audited: true },
        type: { type: 'enum', values: SD_CASE_TYPES, defaultValue: 'Question', inList: true, inDetail: true, inEdit: true, audited: true },
        source: { type: 'enum', values: SD_CASE_SOURCES, defaultValue: 'Web', inList: true, inDetail: true, inEdit: true, audited: true },
        // Customer and ownership.
        accountId: { type: 'link', entityKey: 'Account', inList: true, inDetail: true, inEdit: true },
        contactId: { type: 'link', entityKey: 'Contact', inList: true, inDetail: true, inEdit: true },
        leadId: { type: 'link', entityKey: 'Lead', inDetail: true, inEdit: true },
        requesterName: { type: 'varchar', maxLength: 255, inDetail: true, inEdit: true },
        requesterEmail: { type: 'email', inDetail: true, inEdit: true },
        // Timing (§6.1): derived from real events, server-owned.
        lastActivityAt: { type: 'datetime', inList: true, inDetail: true, sortable: true },
        firstResponseAt: { type: 'datetime', inDetail: true, sortable: true },
        lastCustomerResponseAt: { type: 'datetime', inDetail: true, sortable: true },
        lastAgentResponseAt: { type: 'datetime', inDetail: true, sortable: true },
        resolvedAt: { type: 'datetime', inList: true, inDetail: true, sortable: true },
        closedAt: { type: 'datetime', inDetail: true, sortable: true },
        reopenedAt: { type: 'datetime', inDetail: true },
        // SLA summary (§5.6): per-target detail lands with SD.8; these are the case-level view.
        slaPolicyId: { type: 'varchar', maxLength: 64, inDetail: true },
        slaState: { type: 'enum', values: SD_CASE_SLA_STATES, defaultValue: 'NotApplicable', inList: true, inDetail: true },
        // Escalation (§5.7), server-owned.
        isEscalated: { type: 'bool', defaultValue: false, inList: true, inDetail: true },
        escalationLevel: { type: 'int', defaultValue: 0, inDetail: true },
        escalatedAt: { type: 'datetime', inDetail: true },
        // Resolution (§5.1).
        resolutionCode: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
        resolutionSummary: { type: 'text', inDetail: true, inEdit: true },
        resolvedById: { type: 'link', entityKey: 'User', inDetail: true },
        // Routing and ownership (§5.3, SD.5). Server-owned: they are set only through the
        // assignment/routing commands, which check eligibility and permission, never by the record API.
        queueId: { type: 'link', entityKey: 'CaseQueue', inList: true, inDetail: true },
        teamId: { type: 'link', entityKey: 'Team', inDetail: true },
        routingRuleId: { type: 'link', entityKey: 'RoutingRule', inDetail: true },
        // Portal access (§5.9): a hidden case is never returned to a portal client.
        isHiddenFromPortal: { type: 'bool', defaultValue: false, inDetail: true, inEdit: true },
      },
      relations: {
        // Activities reach a case through explicit `entity_links` rows (the generic related-record
        // endpoint), so no activity metadata has to change for the link to work.
        emails: { type: 'manyMany', target: 'Email' },
        calls: { type: 'manyMany', target: 'Call' },
        meetings: { type: 'manyMany', target: 'Meeting' },
        tasks: { type: 'manyMany', target: 'Task' },
      },
      // Declarative only — the physical indexes are created by migration
      // `database/migrations/033_phase19_service_desk.sql`; the names are kept in step so a reader
      // can move between metadata and DDL without a lookup.
      indexes: [
        { name: 'uq_entity_records_case_number', fields: ['caseNumber'], unique: true },
        { name: 'idx_entity_records_case_status', fields: ['status', 'modifiedAt'] },
        { name: 'idx_entity_records_case_assignee', fields: ['assignedUserId', 'status'] },
        { name: 'idx_entity_records_case_account', fields: ['accountId'] },
        { name: 'idx_entity_records_case_contact', fields: ['contactId'] },
        { name: 'idx_entity_records_case_queue', fields: ['queueId', 'status'] },
        { name: 'idx_entity_records_case_team', fields: ['teamId', 'status'] },
      ],
      layouts: {
        list: [{ entity: 'Case', type: 'list', panels: [{ name: 'list', position: 0, fields: ['caseNumber', 'name', 'status', 'priority', 'type', 'accountId', 'assignedUserId', 'modifiedAt'] }] }],
        detail: [
          {
            entity: 'Case',
            type: 'detail',
            panels: [
              { name: 'overview', label: 'Overview', position: 0, fields: ['caseNumber', 'name', 'description', 'status', 'priority', 'severity', 'type', 'source'] },
              { name: 'requester', label: 'Requester', position: 10, fields: ['accountId', 'contactId', 'leadId', 'requesterName', 'requesterEmail'] },
              { name: 'ownership', label: 'Ownership', position: 20, fields: ['assignedUserId', 'teamId', 'queueId', 'routingRuleId', 'teams'] },
              { name: 'timing', label: 'Timeline', position: 30, fields: ['lastActivityAt', 'firstResponseAt', 'lastCustomerResponseAt', 'lastAgentResponseAt', 'resolvedAt', 'closedAt', 'reopenedAt'] },
              { name: 'sla', label: 'SLA', position: 40, fields: ['slaPolicyId', 'slaState', 'isEscalated', 'escalationLevel', 'escalatedAt'] },
              { name: 'resolution', label: 'Resolution', position: 50, fields: ['resolutionCode', 'resolutionSummary', 'resolvedById', 'isHiddenFromPortal'] },
            ],
          },
        ],
        edit: [
          {
            entity: 'Case',
            type: 'edit',
            panels: [
              { name: 'main', label: 'Case', position: 0, fields: ['name', 'description', 'status', 'priority', 'severity', 'type', 'source'] },
              { name: 'requester', label: 'Requester', position: 10, fields: ['accountId', 'contactId', 'leadId', 'requesterName', 'requesterEmail'] },
              { name: 'ownership', label: 'Ownership', position: 20, fields: ['assignedUserId', 'teams'] },
            ],
          },
        ],
      },
      record: { displayField: 'name', removable: true, followable: true, streamable: true },
      client: {},
      acl: {
        // Baseline defaults (PLAN §10.2): agents create and read cases; editing and streaming are
        // scoped to the record owner. An administrator narrows or widens this per role.
        permissions: { Case: { create: 'yes', read: 'all', edit: 'own', delete: 'own', stream: 'own' } },
      },
    },
  };
}

/**
 * SD.5 — queue configuration: `CaseQueue`, its `QueueMember` join and the `RoutingRule` table
 * (PLAN_Phase_19_ServiceDesk.md §5.3, §6.1).
 *
 * These are ordinary metadata records, so configuration is listable/auditable/importable through the
 * generic API like any other entity, and the module's `beforeValidate` guard refuses writes while the
 * `queues` capability is off. Configuration writes are administrator-scoped (`create/edit/delete:
 * 'no'` for regular roles; an administrator bypasses) while `read: 'all'` lets a team-lead view pick
 * a queue; the workload endpoint narrows *whose* numbers a viewer sees.
 */
function serviceDeskQueueEntities(): MetadataSeedEntry[] {
  return [
    {
      scope: 'entity',
      name: 'CaseQueue',
      data: {
        name: 'CaseQueue',
        label: 'Case Queue',
        isEntity: true,
        fields: {
          ...standardFields,
          name: { ...standardFields.name, label: 'Name', required: true },
          code: { type: 'varchar', maxLength: 32, required: true, inList: true, inDetail: true, inEdit: true },
          description: { type: 'text', inDetail: true, inEdit: true },
          isActive: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
          strategy: { type: 'enum', values: SD_ASSIGNMENT_STRATEGIES, defaultValue: 'manual', inList: true, inDetail: true, inEdit: true },
          fallbackBehavior: { type: 'enum', values: SD_FALLBACK_BEHAVIORS, defaultValue: 'unassigned', inDetail: true, inEdit: true },
          defaultTeamId: { type: 'link', entityKey: 'Team', inDetail: true, inEdit: true },
          defaultAssignedUserId: { type: 'link', entityKey: 'User', inDetail: true, inEdit: true },
          sortOrder: { type: 'int', defaultValue: 0, inList: true, inDetail: true, inEdit: true },
          // Server-owned round-robin cursor, advanced under a row lock (never client-writable).
          lastAssignedUserId: { type: 'link', entityKey: 'User', inDetail: true },
          lastAssignedAt: { type: 'datetime', inDetail: true },
        },
        relations: {},
        indexes: [
          { name: 'uq_entity_records_case_queue_code', fields: ['code'], unique: true },
          { name: 'idx_entity_records_case_queue_active', fields: ['isActive', 'sortOrder'] },
        ],
        layouts: {
          list: [{ entity: 'CaseQueue', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'code', 'strategy', 'fallbackBehavior', 'defaultTeamId', 'isActive', 'sortOrder'] }] }],
          detail: [
            { entity: 'CaseQueue', type: 'detail', panels: [
              { name: 'main', label: 'Queue', position: 0, fields: ['name', 'code', 'description', 'isActive', 'sortOrder'] },
              { name: 'assignment', label: 'Assignment', position: 10, fields: ['strategy', 'fallbackBehavior', 'defaultTeamId', 'defaultAssignedUserId', 'lastAssignedUserId', 'lastAssignedAt'] },
            ] },
          ],
          edit: [
            { entity: 'CaseQueue', type: 'edit', panels: [
              { name: 'main', label: 'Queue', position: 0, fields: ['name', 'code', 'description', 'isActive', 'sortOrder'] },
              { name: 'assignment', label: 'Assignment', position: 10, fields: ['strategy', 'fallbackBehavior', 'defaultTeamId', 'defaultAssignedUserId'] },
            ] },
          ],
        },
        record: { displayField: 'name', removable: true, followable: false, streamable: false },
        client: {},
        acl: { permissions: { CaseQueue: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' } } },
      },
    },
    {
      scope: 'entity',
      name: 'QueueMember',
      data: {
        name: 'QueueMember',
        label: 'Queue Member',
        isEntity: true,
        fields: {
          ...standardFields,
          name: { ...standardFields.name, inList: false, inDetail: false, inEdit: false },
          queueId: { type: 'link', entityKey: 'CaseQueue', required: true, inList: true, inDetail: true, inEdit: true },
          userId: { type: 'link', entityKey: 'User', required: true, inList: true, inDetail: true, inEdit: true },
          isActive: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
          priority: { type: 'int', defaultValue: 0, inList: true, inDetail: true, inEdit: true },
        },
        relations: {},
        indexes: [
          { name: 'uq_entity_records_queue_member', fields: ['queueId', 'userId'], unique: true },
        ],
        layouts: {
          list: [{ entity: 'QueueMember', type: 'list', panels: [{ name: 'list', position: 0, fields: ['queueId', 'userId', 'priority', 'isActive'] }] }],
          detail: [{ entity: 'QueueMember', type: 'detail', panels: [{ name: 'main', label: 'Membership', position: 0, fields: ['queueId', 'userId', 'priority', 'isActive'] }] }],
          edit: [{ entity: 'QueueMember', type: 'edit', panels: [{ name: 'main', label: 'Membership', position: 0, fields: ['queueId', 'userId', 'priority', 'isActive'] }] }],
        },
        record: { displayField: 'name', removable: true, followable: false, streamable: false },
        client: {},
        acl: { permissions: { QueueMember: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' } } },
      },
    },
    {
      scope: 'entity',
      name: 'RoutingRule',
      data: {
        name: 'RoutingRule',
        label: 'Routing Rule',
        isEntity: true,
        fields: {
          ...standardFields,
          name: { ...standardFields.name, label: 'Name', required: true },
          description: { type: 'text', inDetail: true, inEdit: true },
          isActive: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
          sortOrder: { type: 'int', defaultValue: 0, inList: true, inDetail: true, inEdit: true },
          // A JSON array of { field, operator, value } — validated at save time; never executable.
          conditions: { type: 'text', required: true, inDetail: true, inEdit: true },
          queueId: { type: 'link', entityKey: 'CaseQueue', inList: true, inDetail: true, inEdit: true },
          teamId: { type: 'link', entityKey: 'Team', inDetail: true, inEdit: true },
          userId: { type: 'link', entityKey: 'User', inDetail: true, inEdit: true },
          strategy: { type: 'enum', values: SD_ASSIGNMENT_STRATEGIES, defaultValue: 'manual', inDetail: true, inEdit: true },
          fallbackBehavior: { type: 'enum', values: SD_FALLBACK_BEHAVIORS, defaultValue: 'unassigned', inDetail: true, inEdit: true },
        },
        relations: {},
        indexes: [
          { name: 'idx_entity_records_routing_rule_active', fields: ['isActive', 'sortOrder'] },
        ],
        layouts: {
          list: [{ entity: 'RoutingRule', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'isActive', 'sortOrder', 'queueId', 'teamId', 'userId', 'strategy'] }] }],
          detail: [{ entity: 'RoutingRule', type: 'detail', panels: [{ name: 'main', label: 'Rule', position: 0, fields: ['name', 'description', 'isActive', 'sortOrder', 'conditions', 'queueId', 'teamId', 'userId', 'strategy', 'fallbackBehavior'] }] }],
          edit: [{ entity: 'RoutingRule', type: 'edit', panels: [{ name: 'main', label: 'Rule', position: 0, fields: ['name', 'description', 'isActive', 'sortOrder', 'conditions', 'queueId', 'teamId', 'userId', 'strategy', 'fallbackBehavior'] }] }],
        },
        record: { displayField: 'name', removable: true, followable: false, streamable: false },
        client: {},
        acl: { permissions: { RoutingRule: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' } } },
      },
    },
  ];
}

/**
 * SD.4/SD.5 — durable case history: `CaseTransition` (the state machine) and `CaseAssignment`
 * (ownership), PLAN_Phase_19_ServiceDesk.md §5.2, §5.3, §6.1.
 *
 * Generic audit records old/new field values with an actor and a timestamp, which is enough to prove
 * *that* something happened — but it cannot carry a transition **reason**, the **command** that ran, a
 * resolution code per cycle, or a routing **decision**. Those are exactly the facts the plan asks to
 * keep, so they live in dedicated records written by the domain services under the service authority.
 * They are not user-writable or user-visible: `read: 'no'` for regular roles, and the module reads
 * them structurally for the authorised history endpoint.
 */
function serviceDeskHistoryEntities(): MetadataSeedEntry[] {
  return [
    {
      scope: 'entity',
      name: 'CaseTransition',
      data: {
        name: 'CaseTransition',
        label: 'Case Transition',
        isEntity: true,
        fields: {
          ...standardFields,
          name: { ...standardFields.name, inList: false, inDetail: false, inEdit: false },
          caseId: { type: 'link', entityKey: 'Case', required: true, inList: true, inDetail: true },
          caseNumber: { type: 'varchar', maxLength: 32, inList: true, inDetail: true },
          fromStatus: { type: 'enum', values: SD_CASE_STATUSES, inList: true, inDetail: true },
          toStatus: { type: 'enum', values: SD_CASE_STATUSES, inList: true, inDetail: true },
          command: { type: 'varchar', maxLength: 32, inList: true, inDetail: true },
          reason: { type: 'text', inDetail: true },
          resolutionCode: { type: 'varchar', maxLength: 64, inDetail: true },
          resolutionSummary: { type: 'text', inDetail: true },
          actorUserId: { type: 'link', entityKey: 'User', inDetail: true },
          actorType: { type: 'varchar', maxLength: 16, inDetail: true },
          occurredAt: { type: 'datetime', required: true, inList: true, inDetail: true, sortable: true },
          idempotencyKey: { type: 'varchar', maxLength: 128, inDetail: true },
        },
        relations: {},
        indexes: [
          { name: 'idx_entity_records_case_transition_case', fields: ['caseId', 'occurredAt'] },
          { name: 'uq_entity_records_case_transition_idem', fields: ['caseId', 'idempotencyKey'], unique: true },
        ],
        layouts: {
          list: [{ entity: 'CaseTransition', type: 'list', panels: [{ name: 'list', position: 0, fields: ['caseNumber', 'fromStatus', 'toStatus', 'command', 'actorUserId', 'occurredAt'] }] }],
          detail: [{ entity: 'CaseTransition', type: 'detail', panels: [{ name: 'main', label: 'Transition', position: 0, fields: ['caseId', 'fromStatus', 'toStatus', 'command', 'reason', 'resolutionCode', 'resolutionSummary', 'actorUserId', 'actorType', 'occurredAt', 'idempotencyKey'] }] }],
        },
        record: { displayField: 'name', removable: false, followable: false, streamable: false },
        client: {},
        acl: { permissions: { CaseTransition: { create: 'no', read: 'no', edit: 'no', delete: 'no', stream: 'no' } } },
      },
    },
    {
      scope: 'entity',
      name: 'CaseAssignment',
      data: {
        name: 'CaseAssignment',
        label: 'Case Assignment',
        isEntity: true,
        fields: {
          ...standardFields,
          name: { ...standardFields.name, inList: false, inDetail: false, inEdit: false },
          caseId: { type: 'link', entityKey: 'Case', required: true, inList: true, inDetail: true },
          caseNumber: { type: 'varchar', maxLength: 32, inList: true, inDetail: true },
          previousAssignedUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true },
          // `assignedUserId` (from standardFields) is the *new* owner; the physical column also drives
          // record-owner ACL on the history row itself.
          previousTeamId: { type: 'link', entityKey: 'Team', inDetail: true },
          teamId: { type: 'link', entityKey: 'Team', inDetail: true },
          queueId: { type: 'link', entityKey: 'CaseQueue', inList: true, inDetail: true },
          strategy: { type: 'varchar', maxLength: 32, inList: true, inDetail: true },
          routingRuleId: { type: 'varchar', maxLength: 64, inDetail: true },
          decision: { type: 'text', inDetail: true },
          reason: { type: 'text', inDetail: true },
          actorUserId: { type: 'link', entityKey: 'User', inDetail: true },
          actorType: { type: 'varchar', maxLength: 16, inDetail: true },
          occurredAt: { type: 'datetime', required: true, inList: true, inDetail: true, sortable: true },
          idempotencyKey: { type: 'varchar', maxLength: 128, inDetail: true },
        },
        relations: {},
        indexes: [
          { name: 'idx_entity_records_case_assignment_case', fields: ['caseId', 'occurredAt'] },
          { name: 'uq_entity_records_case_assignment_idem', fields: ['caseId', 'idempotencyKey'], unique: true },
        ],
        layouts: {
          list: [{ entity: 'CaseAssignment', type: 'list', panels: [{ name: 'list', position: 0, fields: ['caseNumber', 'previousAssignedUserId', 'assignedUserId', 'queueId', 'strategy', 'actorUserId', 'occurredAt'] }] }],
          detail: [{ entity: 'CaseAssignment', type: 'detail', panels: [{ name: 'main', label: 'Assignment', position: 0, fields: ['caseId', 'previousAssignedUserId', 'assignedUserId', 'previousTeamId', 'teamId', 'queueId', 'strategy', 'routingRuleId', 'decision', 'reason', 'actorUserId', 'actorType', 'occurredAt', 'idempotencyKey'] }] }],
        },
        record: { displayField: 'name', removable: false, followable: false, streamable: false },
        client: {},
        acl: { permissions: { CaseAssignment: { create: 'no', read: 'no', edit: 'no', delete: 'no', stream: 'no' } } },
      },
    },
  // SD.8 — business calendars and SLA policies/clocks (metadata only; no migration needed).
  {
    scope: 'entity',
    name: 'BusinessCalendar',
    data: {
      name: 'BusinessCalendar',
      label: 'Business Calendar',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields.name, required: true },
        code: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
        timezone: { type: 'varchar', maxLength: 64, required: true, inList: true, inDetail: true, inEdit: true },
        intervals: { type: 'text', label: 'Weekly intervals (JSON)', inDetail: true, inEdit: true },
        holidays: { type: 'text', label: 'Holidays/exceptions (JSON)', inDetail: true, inEdit: true },
        isActive: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        isDefault: { type: 'bool', defaultValue: false, inList: true, inDetail: true, inEdit: true },
      },
      relations: {},
      record: { displayField: 'name', removable: true },
      client: {},
      acl: { permissions: { BusinessCalendar: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' } } },
    },
  },
  {
    scope: 'entity',
    name: 'SLAPolicy',
    data: {
      name: 'SLAPolicy',
      label: 'SLA Policy',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields.name, required: true },
        code: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
        isActive: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
        priority: { type: 'int', defaultValue: 0, inList: true, inDetail: true, inEdit: true },
        conditions: { type: 'text', label: 'Conditions (JSON)', inDetail: true, inEdit: true },
        calendarId: { type: 'link', entityKey: 'BusinessCalendar', inDetail: true, inEdit: true },
        firstResponseMinutes: { type: 'int', defaultValue: 0, inDetail: true, inEdit: true },
        nextResponseMinutes: { type: 'int', defaultValue: 0, inDetail: true, inEdit: true },
        resolutionMinutes: { type: 'int', defaultValue: 0, inDetail: true, inEdit: true },
        warningThresholds: { type: 'text', label: 'Warning thresholds (JSON)', inDetail: true, inEdit: true },
        pauseOnCustomer: { type: 'bool', defaultValue: true, inDetail: true, inEdit: true },
        pauseOnInternal: { type: 'bool', defaultValue: true, inDetail: true, inEdit: true },
        version: { type: 'int', defaultValue: 1, inDetail: true, inEdit: true },
      },
      relations: {},
      record: { displayField: 'name', removable: true },
      client: {},
      acl: { permissions: { SLAPolicy: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' } } },
    },
  },
  {
    scope: 'entity',
    name: 'CaseSLAClock',
    data: {
      name: 'CaseSLAClock',
      label: 'Case SLA Clock',
      isEntity: true,
      fields: {
        ...standardFields,
        caseId: { type: 'link', entityKey: 'Case', required: true, inList: true, inDetail: true, inEdit: true },
        targetType: { type: 'enum', values: ['firstResponse', 'nextResponse', 'resolution'], required: true, inList: true, inDetail: true, inEdit: true },
        policyId: { type: 'varchar', maxLength: 64, inDetail: true, inEdit: true },
        policyVersion: { type: 'int', defaultValue: 1, inDetail: true, inEdit: true },
        startAt: { type: 'datetime', inDetail: true, inEdit: true },
        dueAt: { type: 'datetime', inList: true, inDetail: true, inEdit: true },
        metAt: { type: 'datetime', inDetail: true, inEdit: true },
        breachedAt: { type: 'datetime', inDetail: true, inEdit: true },
        pausedAt: { type: 'datetime', inDetail: true, inEdit: true },
        resumedAt: { type: 'datetime', inDetail: true, inEdit: true },
        elapsedMinutes: { type: 'int', defaultValue: 0, inDetail: true, inEdit: true },
        status: { type: 'enum', values: ['onTrack', 'warning', 'breached', 'paused', 'met', 'notApplicable'], defaultValue: 'onTrack', inList: true, inDetail: true, inEdit: true },
        cycle: { type: 'int', defaultValue: 1, inDetail: true, inEdit: true },
      },
      relations: {},
      record: { displayField: 'name', removable: false, followable: false, streamable: false },
      client: {},
      acl: { permissions: { CaseSLAClock: { create: 'no', read: 'no', edit: 'no', delete: 'no', stream: 'no' } } },
    },
  },
  // SD.10 — Knowledge Base (minimal article/category capability).
  {
    scope: 'entity',
    name: 'KnowledgeCategory',
    data: {
      name: 'KnowledgeCategory',
      label: 'Knowledge Category',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields.name, required: true },
        code: { type: 'varchar', maxLength: 64, inList: true, inDetail: true, inEdit: true },
        parentCategoryId: { type: 'link', entityKey: 'KnowledgeCategory', inDetail: true, inEdit: true },
        sortOrder: { type: 'int', defaultValue: 0, inList: true, inDetail: true, inEdit: true },
        isActive: { type: 'bool', defaultValue: true, inList: true, inDetail: true, inEdit: true },
      },
      relations: {},
      record: { displayField: 'name', removable: true },
      client: {},
      acl: { permissions: { KnowledgeCategory: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' } } },
    },
  },
  {
    scope: 'entity',
    name: 'KnowledgeArticle',
    data: {
      name: 'KnowledgeArticle',
      label: 'Knowledge Article',
      isEntity: true,
      fields: {
        ...standardFields,
        name: { ...standardFields.name, label: 'Title', required: true },
        slug: { type: 'varchar', maxLength: 128, inList: true, inDetail: true, inEdit: true },
        summary: { type: 'text', inList: true, inDetail: true, inEdit: true },
        body: { type: 'text', label: 'Body', inDetail: true, inEdit: true },
        categoryId: { type: 'link', entityKey: 'KnowledgeCategory', inList: true, inDetail: true, inEdit: true },
        language: { type: 'varchar', maxLength: 16, defaultValue: 'en', inList: true, inDetail: true, inEdit: true },
        status: { type: 'enum', values: ['Draft', 'InReview', 'Published', 'Archived', 'Expired'], defaultValue: 'Draft', inList: true, inDetail: true, inEdit: true, audited: true },
        isInternal: { type: 'bool', defaultValue: false, inList: true, inDetail: true, inEdit: true },
        publishedAt: { type: 'datetime', inDetail: true, inEdit: true },
        expiresAt: { type: 'datetime', inDetail: true, inEdit: true },
        authorId: { type: 'link', entityKey: 'User', inDetail: true, inEdit: true },
        reviewerId: { type: 'link', entityKey: 'User', inDetail: true, inEdit: true },
        tags: { type: 'varchar', maxLength: 512, inDetail: true, inEdit: true },
      },
      relations: {},
      record: { displayField: 'name', removable: true },
      client: {},
      acl: { permissions: { KnowledgeArticle: { create: 'no', read: 'all', edit: 'no', delete: 'no', stream: 'no' } } },
    },
  },
  ];
}
