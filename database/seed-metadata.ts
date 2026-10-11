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
];
