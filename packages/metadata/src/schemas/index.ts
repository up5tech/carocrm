import { z } from 'zod';

import { type EntityRelationTabs, EntityRelationTabsSchema } from '../relation-tabs.js';

export const fieldTypes = [
  'varchar',
  'text',
  'int',
  'float',
  'decimal',
  'bool',
  'date',
  'datetime',
  'enum',
  'multiEnum',
  'currency',
  'url',
  'email',
  'phone',
  'password',
  'link',
  'linkOne',
  'linkMultiple',
  'linkParent',
  'foreign',
  'file',
  'image',
  'attachmentMultiple',
  'formula',
  'generated',
  'aggregationCount',
] as const;

export const relationTypes = ['oneToOne', 'oneToMany', 'manyToOne', 'manyToMany', 'parentChild'] as const;

export const aclRoleLevels = ['yes', 'all', 'team', 'own', 'no'] as const;

export const aclActions = ['create', 'read', 'edit', 'delete', 'stream'] as const;

export const FieldDefinitionSchema = z.object({
  type: z.string(),
  required: z.boolean().default(false),
  label: z.string().optional(),
  maxLength: z.number().int().positive().optional(),
  defaultValue: z.any().optional(),
  entityKey: z.string().optional(),
  values: z.array(z.string()).optional(),
  enum: z.array(z.string()).optional(),
  options: z.record(z.string(), z.any()).optional(),
  notDisabled: z.boolean().optional(),
  inEdit: z.boolean().optional(),
  inDetail: z.boolean().optional(),
  inList: z.boolean().optional(),
  inFilter: z.boolean().optional(),
  inSearch: z.boolean().optional(),
  importable: z.boolean().optional(),
  exportable: z.boolean().optional(),
  sortable: z.boolean().optional(),
  unique: z.boolean().optional(),
  audited: z.boolean().optional(),
  description: z.string().optional(),
  /** Sandboxed expression that computes this field's value on save (PLAN §22, field type `formula`). */
  formula: z.string().max(2000).optional(),
});

export type FieldDefinition = z.infer<typeof FieldDefinitionSchema>;

export const RelationDefinitionSchema = z.object({
  type: z.string(),
  target: z.string(),
  mappedBy: z.string().optional(),
  inverseBy: z.string().optional(),
  /** Display name for the relation panel; null clears it back to the humanized relation name. */
  label: z.string().max(120).nullish(),
  required: z.boolean().default(false),
  removable: z.boolean().default(true),
  straight: z.boolean().default(false),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type RelationDefinition = z.infer<typeof RelationDefinitionSchema>;

export const IndexDefinitionSchema = z.object({
  name: z.string(),
  fields: z.array(z.string()),
  unique: z.boolean().default(false),
});

export type IndexDefinition = z.infer<typeof IndexDefinitionSchema>;

export const AclDefinitionSchema = z.object({
  permissions: z.record(z.string(), z.record(z.string(), z.enum(aclRoleLevels))).optional(),
  fieldPermissions: z.record(z.string(), z.record(z.string(), z.enum(aclRoleLevels))).optional(),
  recordAccess: z.record(z.string(), z.record(z.string(), z.enum(aclRoleLevels))).optional(),
});

export type AclDefinition = z.infer<typeof AclDefinitionSchema>;

export const LayoutPanelSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  position: z.number().int().default(0),
  fields: z.array(z.string()).optional(),
  tabs: z.array(z.string()).optional(),
});

export type LayoutPanel = z.infer<typeof LayoutPanelSchema>;

export const LayoutDefinitionSchema = z.object({
  entity: z.string(),
  type: z.enum(['list', 'detail', 'edit', 'filter', 'search', 'massUpdate', 'panel', 'popup']),
  panels: z.array(LayoutPanelSchema),
});

export type LayoutDefinition = z.infer<typeof LayoutDefinitionSchema>;

export const RecordDefinitionSchema = z.object({
  displayField: z.string().optional(),
  nameField: z.string().optional(),
  duplicate: z.boolean().default(true),
  followable: z.boolean().default(true),
  streamable: z.boolean().default(true),
  audited: z.boolean().default(false),
  removable: z.boolean().default(true),
  mergeable: z.boolean().default(false),
  importable: z.boolean().default(true),
  exportable: z.boolean().default(true),
});

export type RecordDefinition = z.infer<typeof RecordDefinitionSchema>;

export const ClientDefinitionSchema = z.object({
  portal: z.boolean().default(false),
  web: z.boolean().default(true),
  api: z.boolean().default(true),
  mobile: z.boolean().default(false),
});

export type ClientDefinition = z.infer<typeof ClientDefinitionSchema>;

/**
 * Per-entity navigation behaviour (PLAN_Phase_20_Settings_UX.md §4.5). Optional: an entity without a
 * `nav` section keeps the grouping and order the platform ships with. `hidden` is presentation — the
 * entity stays fully usable by URL and API.
 */
export const NavigationSectionSchema = z.object({
  hidden: z.boolean().default(false),
  /** Sort weight inside its navigation group; ties break on the entity name. `null` clears it. */
  order: z.number().int().min(-100000).max(100000).nullish(),
  /** Group key. Without one the entity lands in the ungrouped remainder of RECORDS. */
  group: z.string().min(1).max(80).nullish(),
  quickCreate: z.boolean().default(true),
  board: z
    .object({
      enabled: z.boolean().default(false),
      groupBy: z.string().max(60).optional(),
      defaultGroupBy: z.string().max(60).optional(),
    })
    .nullish(),
});

export type NavigationSection = z.infer<typeof NavigationSectionSchema>;

/**
 * Declarative UI/validation rules (PLAN §21). The section is guarded shallowly here; every rule is
 * parsed and formula-checked by `@carocrm/formula` before metadata is accepted.
 */
export const DynamicLogicSectionSchema = z.object({
  rules: z.array(z.record(z.string(), z.unknown())).max(100),
});

export type DynamicLogicSection = { rules: Record<string, unknown>[] };

export const EntityDefinitionSchema = z.object({
  name: z.string(),
  label: z.string(),
  /** Icon name resolved against the SPA's fixed `ENTITY_ICONS` set; null clears the choice. */
  icon: z.string().max(40).nullish(),
  table: z.string().optional(),
  isEntity: z.boolean().default(true),
  fields: z.record(z.string(), FieldDefinitionSchema),
  relations: z.record(z.string(), RelationDefinitionSchema),
  indexes: z.array(IndexDefinitionSchema).default([]),
  acl: AclDefinitionSchema.optional(),
  /**
   * Per-view panel layout (PLAN §8). Each entry groups fields into a labelled panel; a view with no
   * entry falls back to the flat field order, so seeded entities keep working untouched.
   */
  layouts: z.record(z.string(), z.array(LayoutDefinitionSchema)).prefault({}),
  /**
   * The relation area of the record page (PLAN_Phase_20_Settings_UX.md §5.11): either today's
   * stacked panels or the tabs the entity's detail layout arranges. Optional — an entity without
   * the section keeps the stacked page.
   */
  detailTabs: EntityRelationTabsSchema.optional(),
  record: RecordDefinitionSchema.prefault({}),
  client: ClientDefinitionSchema.prefault({}),
  nav: NavigationSectionSchema.optional(),
  dynamicLogic: DynamicLogicSectionSchema.optional(),
});
export type EntityDefinition = {
  name: string;
  label: string;
  icon?: string | null | undefined;
  table?: string | undefined;
  isEntity: boolean;
  fields: Record<string, FieldDefinition>;
  relations: Record<string, RelationDefinition>;
  indexes: IndexDefinition[];
  acl?: AclDefinition | undefined;
  layouts: Record<string, LayoutDefinition[]>;
  detailTabs?: EntityRelationTabs | undefined;
  record: RecordDefinition;
  client: ClientDefinition;
  nav?: NavigationSection | undefined;
  dynamicLogic?: DynamicLogicSection | undefined;
};

export const PermissionDefinitionSchema = z.object({
  name: z.string(),
  label: z.string(),
  scope: z.string().optional(),
});

export type PermissionDefinition = z.infer<typeof PermissionDefinitionSchema>;

export const JobDefinitionSchema = z.object({
  name: z.string(),
  scheduling: z.string().optional(),
  handler: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
});

export type JobDefinition = z.infer<typeof JobDefinitionSchema>;

export const RouteDefinitionSchema = z.object({
  path: z.string(),
  method: z.string(),
  handler: z.string(),
  description: z.string().optional(),
});

export type RouteDefinition = z.infer<typeof RouteDefinitionSchema>;

export const MetadataManifestSchema = z.object({
  name: z.string(),
  id: z.string(),
  version: z.string(),
  minPlatformVersion: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type MetadataManifest = z.infer<typeof MetadataManifestSchema>;