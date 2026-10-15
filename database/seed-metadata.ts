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
      relations: {},
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
];

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
