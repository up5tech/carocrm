export type ID = string;

export type UserType = 'admin' | 'regular' | 'api' | 'portal' | 'system';

export type EntityField =
  | 'varchar'
  | 'text'
  | 'int'
  | 'float'
  | 'decimal'
  | 'bool'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'multiEnum'
  | 'currency'
  | 'url'
  | 'email'
  | 'phone'
  | 'password'
  | 'link'
  | 'linkOne'
  | 'linkMultiple'
  | 'linkParent'
  | 'foreign'
  | 'file'
  | 'image'
  | 'attachmentMultiple'
  | 'formula'
  | 'generated'
  | 'aggregationCount';

export type RelationType =
  | 'oneToOne'
  | 'oneToMany'
  | 'manyToOne'
  | 'manyToMany'
  | 'parentChild';

export type AclRoleLevel = 'yes' | 'all' | 'team' | 'own' | 'no';

export type AclAction = 'create' | 'read' | 'edit' | 'delete' | 'stream';

export type SortDirection = 'asc' | 'desc';

export interface PaginationParams {
  offset?: number;
  limit?: number;
}

export interface ListResponse<T> {
  list: T[];
  total: number;
  offset: number;
  count: number;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface HealthResponse {
  status: 'ok' | 'error';
  info: Record<string, { status: string; details?: unknown }>;
  error: Record<string, { status: string; details?: unknown }>;
}

export interface AppUserResponse {
  id: ID;
  userName: string;
  firstName: string;
  lastName: string;
  email: string;
  userType: UserType;
  locale: string;
  timezone: string;
  portalId: ID | null;
  teams: ID[];
  roles: ID[];
  permissions: Record<string, AclRoleLevel>;
}

export interface MetadataVersionResponse {
  version: number;
  entities: Record<string, unknown>;
}