/** Field + entity definitions as served by `GET /api/v1/Metadata` (PLAN §12, §79). */
export interface FieldDefinition {
  type: string;
  required?: boolean | undefined;
  label?: string | undefined;
  maxLength?: number | undefined;
  defaultValue?: unknown;
  entityKey?: string | undefined;
  values?: string[] | undefined;
  enum?: string[] | undefined;
  inList?: boolean | undefined;
  inDetail?: boolean | undefined;
  inEdit?: boolean | undefined;
  inFilter?: boolean | undefined;
  sortable?: boolean | undefined;
  audited?: boolean | undefined;
  formula?: string | undefined;
}

export interface RelationDefinition {
  type: string;
  target: string;
  mappedBy?: string | undefined;
  foreign?: string | undefined;
  label?: string | undefined;
}

export interface EntityDefinition {
  name: string;
  label: string;
  isEntity: boolean;
  fields: Record<string, FieldDefinition>;
  relations: Record<string, RelationDefinition>;
  record?: { displayField?: string | undefined; nameField?: string | undefined } | undefined;
  client?: { web?: boolean | undefined } | undefined;
  /** Declarative rules evaluated in the form and on the server (PLAN §21). */
  dynamicLogic?: { rules: Record<string, unknown>[] } | undefined;
}

export type Metadata = Record<string, EntityDefinition>;

export interface ListResult<T = Record<string, unknown>> {
  list: T[];
  total?: number;
  offset: number;
  count: number;
}

export interface Principal {
  id: string;
  userName: string;
  type: string;
  roles: string[];
  teams: string[];
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
  type: string;
  role: string[];
  csrfToken: string;
}
