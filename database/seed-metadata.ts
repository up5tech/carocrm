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
      relations: {},
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
      }),
      relations: {},
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
      relations: {},
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
  readonly extraFields?: Record<string, Record<string, unknown>>;
  readonly extraEditFields?: readonly string[];
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
  };
}

function documentEntity(spec: DocumentSpec): MetadataSeedEntry {
  const prefix = spec.entity.toLowerCase();
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
        { name: `idx_${prefix}_account`, fields: ['accountId'] },
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
                fields: ['number', 'status', 'accountId', spec.dateField, 'currency', 'grossTotal', 'amountDue', 'assignedUserId'],
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
                fields: ['number', 'status', 'accountId', 'contactId', spec.dateField, 'currency', 'description', 'assignedUserId'],
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
                fields: ['accountId', 'contactId', spec.dateField, 'currency', 'description', ...(spec.extraEditFields ?? [])],
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
            panels: [{ name: 'list', position: 0, fields: ['position', 'name', 'sku', 'quantity', 'unitPrice', 'netAmount', 'grossAmount'] }],
          },
        ],
        detail: [
          {
            entity: spec.itemEntity,
            type: 'detail',
            panels: [
              { name: 'main', label: 'Line', position: 0, fields: ['position', 'productId', 'name', 'sku', 'unit', 'quantity', 'unitPrice', 'discountPercent', 'discountAmount'] },
              { name: 'tax', label: 'Tax', position: 10, fields: ['taxCodeId', 'taxRatePercent', 'taxSource', 'netAmount', 'taxAmount', 'grossAmount'] },
            ],
          },
        ],
        edit: [
          {
            entity: spec.itemEntity,
            type: 'edit',
            panels: [
              { name: 'main', label: 'Line', position: 0, fields: ['position', 'productId', 'name', 'sku', 'unit', 'quantity', 'unitPrice', 'discountPercent', 'discountAmount', 'taxCodeId'] },
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
      // Promoted to a link to `Warehouse` in 19-S.14, when the inventory entities exist.
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
  });
}

// ---------------------------------------------------------------------------
// Phase 19-S.10 – 19-S.11 — payments and the records that adjust a balance
// ---------------------------------------------------------------------------

/** A configurable lookup (payment method or channel) a payment may reference. */
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
        reference: { type: 'varchar', maxLength: 128, inList: true, inDetail: true, inEdit: true },
        memo: { type: 'text', inDetail: true, inEdit: true },
        status: { type: 'enum', values: ['draft', 'confirmed', 'cancelled'], defaultValue: 'draft', inList: true, inDetail: true, audited: true },
        // Derived from the allocation rows. Never settable by a client: the write guard refuses them.
        allocatedAmount: decimalField({ inList: true, inDetail: true }),
        unallocatedAmount: decimalField({ inList: true, inDetail: true }),
        allocationStatus: { type: 'enum', values: ['unallocated', 'partiallyAllocated', 'allocated'], defaultValue: 'unallocated', inList: true, inDetail: true },
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
        { name: 'idx_payment_date', fields: ['paymentDate'] },
      ],
      layouts: {
        list: [{ entity: 'Payment', type: 'list', panels: [{ name: 'list', position: 0, fields: ['name', 'paymentDate', 'direction', 'accountId', 'amount', 'currency', 'allocationStatus', 'status'] }] }],
        detail: [
          { entity: 'Payment', type: 'detail', panels: [{ name: 'main', label: 'Payment', position: 0, fields: ['name', 'direction', 'status', 'paymentDate', 'accountId', 'contactId', 'amount', 'currency', 'paymentMethodId', 'paymentChannelId', 'reference', 'memo'] }] },
          { entity: 'Payment', type: 'detail', panels: [{ name: 'allocation', label: 'Allocation', position: 10, fields: ['allocatedAmount', 'unallocatedAmount', 'allocationStatus'] }] },
        ],
        edit: [{ entity: 'Payment', type: 'edit', panels: [{ name: 'main', label: 'Payment', position: 0, fields: ['direction', 'paymentDate', 'accountId', 'contactId', 'amount', 'currency', 'paymentMethodId', 'paymentChannelId', 'reference', 'memo'] }] }],
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
