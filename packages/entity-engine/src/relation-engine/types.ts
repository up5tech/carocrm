export interface RelationLink {
  id: string;
  entityTypeA: string;
  recordIdA: string;
  relationName: string;
  entityTypeB: string;
  recordIdB: string;
  roleA?: string | undefined;
  roleB?: string | undefined;
  createdAt: Date;
  metadata?: Record<string, unknown> | undefined;
}

export interface LinkOptions {
  entityTypeA: string;
  recordIdA: string;
  relationName: string;
  entityTypeB: string;
  recordIdB: string;
  roleA?: string | undefined;
  roleB?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RelationQueryOptions {
  entity: string;
  id: string;
  relation: string;
  offset?: number;
  limit?: number;
  where?: Record<string, unknown>;
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  select?: string[];
}

export interface RelationCount {
  count: number;
}

export interface RelationDefinition {
  type: string;
  target: string;
  mappedBy?: string;
  inverseBy?: string;
  label?: string;
  required?: boolean;
  removable?: boolean;
  straight?: boolean;
  metadata?: Record<string, unknown> | undefined;
}