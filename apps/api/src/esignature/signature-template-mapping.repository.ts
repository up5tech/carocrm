import { randomUUID } from 'node:crypto';

import { ConcurrencyConflictError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';

/**
 * Phase 19-ES.2 — template mappings
 * (`PLAN_Phase_19_ESignature.md` §6.7, §4.4).
 *
 * A mapping says which DocuSign template a CRM workflow uses, which of its roles a CRM recipient
 * fills, and which CRM values may reach its tabs. It is configuration a provider call is built from,
 * so the shape is checked here and the *references* are checked where the metadata is known (ES.7):
 * nothing in this table is ever evaluated.
 *
 * Two refusals are the whole security story:
 *
 * - **No expression.** A mapping value is a literal field name from an allowlist, not a formula.
 *   `packages/formula` exists and is sandboxed elsewhere, but plan §6.7 forbids reusing it as a way to
 *   execute arbitrary paths from configuration, so an object or a string that looks like an
 *   expression (`${…}`, `#{…}`, `{{…}}`) is refused outright.
 * - **No unknown keys.** A role or field entry carries only the declared properties; an extra one is
 *   a sign that a caller is trying to smuggle configuration the module does not understand.
 *
 * `connection_id` is part of the identity of a mapping: a provider template id means something only
 * inside the account that owns it (plan §13 ES.7 acceptance).
 */

export const MAPPING_TYPES = ['workflow', 'document_type', 'process'] as const;
export type ESignatureMappingType = (typeof MAPPING_TYPES)[number];

export interface SignatureRoleMapping {
  readonly roleName: string;
  readonly recipientType: 'signer' | 'carbon_copy';
  readonly routingOrder: number;
  /** Where the signer identity comes from: a fixed CRM field on the source record, or a typed value. */
  readonly source: 'crmField' | 'manual';
  readonly crmField: string | null;
}

export interface SignatureFieldMapping {
  readonly tabName: string;
  readonly crmField: string;
  readonly required: boolean;
}

export interface SignatureTemplateMapping {
  readonly id: string;
  readonly name: string;
  readonly mappingType: ESignatureMappingType;
  readonly connectionId: string;
  readonly providerTemplateId: string;
  readonly providerTemplateName: string | null;
  readonly supportedSourceEntities: readonly string[];
  readonly roleMappings: readonly SignatureRoleMapping[];
  readonly fieldMappings: readonly SignatureFieldMapping[];
  readonly defaultSubject: string | null;
  readonly defaultMessage: string | null;
  readonly isActive: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly createdById: string | null;
  readonly deleted: boolean;
}

export interface TemplateMappingInput {
  name: string;
  mappingType?: ESignatureMappingType;
  connectionId: string;
  providerTemplateId: string;
  providerTemplateName?: string | null;
  supportedSourceEntities?: readonly string[];
  roleMappings?: readonly unknown[];
  fieldMappings?: readonly unknown[];
  defaultSubject?: string | null;
  defaultMessage?: string | null;
  isActive?: boolean;
  createdById?: string;
  id?: string;
}

/** Anything shaped like an expression rather than a field name. */
const EXPRESSION_LIKE = /[{$#]\{.*\}/s;

@Injectable()
export class SignatureTemplateMappingRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private get db() {
    return currentTx() ?? this.database.db;
  }

  async findById(id: string): Promise<SignatureTemplateMapping | undefined> {
    const row = await this.db
      .selectFrom('signature_template_mappings')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toMapping(row);
  }

  async listForConnection(connectionId: string, options: { activeOnly?: boolean } = {}): Promise<SignatureTemplateMapping[]> {
    let query = this.db
      .selectFrom('signature_template_mappings')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('deleted_at', 'is', null);
    if (options.activeOnly === true) query = query.where('is_active', '=', true);
    const rows = await query.orderBy('name', 'asc').execute();
    return rows.map((row) => toMapping(row));
  }

  async create(input: TemplateMappingInput): Promise<SignatureTemplateMapping> {
    const name = input.name.trim();
    if (name === '') throw new ValidationError('A template mapping needs a name.');
    const providerTemplateId = input.providerTemplateId.trim();
    if (providerTemplateId === '') throw new ValidationError('A template mapping names a provider template.');
    const mappingType = input.mappingType ?? 'workflow';
    if (!(MAPPING_TYPES as readonly string[]).includes(mappingType)) throw new ValidationError('Unknown mapping type.', { mappingType });

    const roles = normalizeRoleMappings(input.roleMappings ?? []);
    const fields = normalizeFieldMappings(input.fieldMappings ?? []);
    const entities = normalizeEntities(input.supportedSourceEntities ?? []);
    const now = new Date();
    const row = await this.db
      .insertInto('signature_template_mappings')
      .values({
        id: input.id ?? randomUUID(),
        name: name.slice(0, 160),
        mapping_type: mappingType,
        connection_id: input.connectionId,
        provider_template_id: providerTemplateId,
        provider_template_name: input.providerTemplateName?.trim().slice(0, 200) || null,
        supported_source_entities: JSON.stringify(entities),
        role_mappings: JSON.stringify(roles),
        field_mappings: JSON.stringify(fields),
        default_subject: input.defaultSubject?.trim().slice(0, 300) || null,
        default_message: input.defaultMessage?.trim().slice(0, 2000) || null,
        is_active: input.isActive === true,
        version: 1,
        created_at: now,
        modified_at: now,
        created_by_id: input.createdById ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toMapping(row);
  }

  /** Replace a mapping's content, version-checked: a stale editor cannot overwrite a newer review. */
  async update(
    id: string,
    expectedVersion: number,
    patch: Partial<TemplateMappingInput>,
    actorId?: string,
  ): Promise<SignatureTemplateMapping> {
    const current = await this.requireById(id);
    if (current.version !== expectedVersion) throw new ConcurrencyConflictError('SignatureTemplateMapping', id);
    const row = await this.db
      .updateTable('signature_template_mappings')
      .set({
        ...(patch.name !== undefined ? { name: String(patch.name).trim().slice(0, 160) } : {}),
        ...(patch.providerTemplateId !== undefined ? { provider_template_id: String(patch.providerTemplateId).trim() } : {}),
        ...(patch.providerTemplateName !== undefined ? { provider_template_name: patch.providerTemplateName?.trim() || null } : {}),
        ...(patch.mappingType !== undefined ? { mapping_type: patch.mappingType } : {}),
        ...(patch.supportedSourceEntities !== undefined ? { supported_source_entities: JSON.stringify(normalizeEntities(patch.supportedSourceEntities)) } : {}),
        ...(patch.roleMappings !== undefined ? { role_mappings: JSON.stringify(normalizeRoleMappings(patch.roleMappings)) } : {}),
        ...(patch.fieldMappings !== undefined ? { field_mappings: JSON.stringify(normalizeFieldMappings(patch.fieldMappings)) } : {}),
        ...(patch.defaultSubject !== undefined ? { default_subject: patch.defaultSubject?.trim() || null } : {}),
        ...(patch.defaultMessage !== undefined ? { default_message: patch.defaultMessage?.trim() || null } : {}),
        ...(patch.isActive !== undefined ? { is_active: patch.isActive === true } : {}),
        version: current.version + 1,
        modified_at: new Date(),
        ...(actorId !== undefined ? { modified_by_id: actorId } : {}),
      })
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) throw new ConcurrencyConflictError('SignatureTemplateMapping', id);
    return toMapping(row);
  }

  /** Deactivate rather than delete: an issued request must still explain which mapping it used. */
  async setActive(id: string, isActive: boolean, actorId?: string): Promise<SignatureTemplateMapping> {
    const current = await this.requireById(id);
    const row = await this.db
      .updateTable('signature_template_mappings')
      .set({ is_active: isActive, version: current.version + 1, modified_at: new Date(), ...(actorId !== undefined ? { modified_by_id: actorId } : {}) })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toMapping(row);
  }

  async softDelete(id: string, actorId?: string): Promise<void> {
    await this.requireById(id);
    await this.db
      .updateTable('signature_template_mappings')
      .set({ deleted_at: new Date(), is_active: false, modified_at: new Date(), ...(actorId !== undefined ? { modified_by_id: actorId } : {}) })
      .where('id', '=', id)
      .execute();
  }

  async requireById(id: string): Promise<SignatureTemplateMapping> {
    const found = await this.findById(id);
    if (found === undefined) throw new ValidationError(`No signature template mapping "${id}".`, { id });
    return found;
  }

  /** The mapping a request would use, by provider template, within one connection. */
  async findByProviderTemplate(connectionId: string, providerTemplateId: string, mappingType: ESignatureMappingType = 'workflow'): Promise<SignatureTemplateMapping | undefined> {
    const row = await this.db
      .selectFrom('signature_template_mappings')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('provider_template_id', '=', providerTemplateId)
      .where('mapping_type', '=', mappingType)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toMapping(row);
  }
}

/**
 * Validate the role entries.
 *
 * The shape is fixed and closed: five properties, no expression, routing order in range. ES.7 checks
 * the *references* (does this CRM field exist, is it readable by the sender); this file only refuses
 * what could never be a plain mapping.
 */
export function normalizeRoleMappings(values: readonly unknown[]): SignatureRoleMapping[] {
  if (!Array.isArray(values)) throw new ValidationError('Role mappings must be an array.');
  if (values.length > 20) throw new ValidationError('A template mapping may declare at most 20 roles.');
  return values.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`Role mapping ${String(index)} must be an object.`);
    const entry = raw as Record<string, unknown>;
    const allowed = new Set(['roleName', 'recipientType', 'routingOrder', 'source', 'crmField']);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) throw new ValidationError(`Role mapping ${String(index)} has an unknown property "${key}".`, { key });
    }
    const roleName = literal(entry['roleName'], `role mapping ${String(index)}.roleName`);
    const source = entry['source'];
    if (source !== 'crmField' && source !== 'manual') throw new ValidationError('A role mapping sources its signer from a CRM field or from a manual entry.', { source });
    const recipientType = entry['recipientType'];
    if (recipientType !== 'signer' && recipientType !== 'carbon_copy') throw new ValidationError('A role mapping names a supported recipient type.', { recipientType });
    const routingOrder = Math.trunc(Number(entry['routingOrder']));
    if (!Number.isFinite(routingOrder) || routingOrder < 1 || routingOrder > 99) throw new ValidationError('A role mapping routing order is between 1 and 99.', { routingOrder: entry['routingOrder'] });
    const crmField = entry['crmField'] === null || entry['crmField'] === undefined ? null : literal(entry['crmField'], 'role mapping crmField');
    if (source === 'crmField' && crmField === null) throw new ValidationError('A CRM-sourced role mapping must name a field.');
    return { roleName, recipientType, routingOrder, source, crmField };
  });
}

export function normalizeFieldMappings(values: readonly unknown[]): SignatureFieldMapping[] {
  if (!Array.isArray(values)) throw new ValidationError('Field mappings must be an array.');
  if (values.length > 100) throw new ValidationError('A template mapping may declare at most 100 fields.');
  return values.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`Field mapping ${String(index)} must be an object.`);
    const entry = raw as Record<string, unknown>;
    const allowed = new Set(['tabName', 'crmField', 'required']);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) throw new ValidationError(`Field mapping ${String(index)} has an unknown property "${key}".`, { key });
    }
    const tabName = literal(entry['tabName'], `field mapping ${String(index)}.tabName`);
    const crmField = literal(entry['crmField'], `field mapping ${String(index)}.crmField`);
    const required = entry['required'];
    if (typeof required !== 'boolean') throw new ValidationError('A field mapping states whether the tab is required.', { index });
    return { tabName, crmField, required };
  });
}

function normalizeEntities(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !/^[A-Z][A-Za-z0-9]{1,62}$/.test(value)) {
      throw new ValidationError('A supported source entity is a metadata entity name.', { value: String(value) });
    }
    if (!out.includes(value)) out.push(value);
  }
  if (out.length > 30) throw new ValidationError('A template mapping may name at most 30 source entities.');
  return out;
}

/** A plain identifier-or-label string: no expression syntax, no control characters. */
function literal(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${where} must be a plain string.`);
  const text = value.trim();
  if (text === '' || text.length > 120) throw new ValidationError(`${where} must be a short plain string.`);
  if (EXPRESSION_LIKE.test(text) || /[\r\n\t]/.test(text)) {
    throw new ValidationError(`${where} must be a literal name, not an expression.`, { where });
  }
  return text;
}

function toMapping(row: {
  id: string;
  name: string;
  mapping_type: string;
  connection_id: string;
  provider_template_id: string;
  provider_template_name: string | null;
  supported_source_entities: unknown;
  role_mappings: unknown;
  field_mappings: unknown;
  default_subject: string | null;
  default_message: string | null;
  is_active: boolean;
  version: number;
  created_at: Date;
  modified_at: Date;
  created_by_id: string | null;
  deleted_at: Date | null;
}): SignatureTemplateMapping {
  return {
    id: row.id,
    name: row.name,
    mappingType: row.mapping_type as ESignatureMappingType,
    connectionId: row.connection_id,
    providerTemplateId: row.provider_template_id,
    providerTemplateName: row.provider_template_name,
    supportedSourceEntities: Array.isArray(row.supported_source_entities) ? (row.supported_source_entities as string[]).filter((s) => typeof s === 'string') : [],
    roleMappings: Array.isArray(row.role_mappings) ? (row.role_mappings as SignatureRoleMapping[]) : [],
    fieldMappings: Array.isArray(row.field_mappings) ? (row.field_mappings as SignatureFieldMapping[]) : [],
    defaultSubject: row.default_subject,
    defaultMessage: row.default_message,
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
    createdById: row.created_by_id,
    deleted: row.deleted_at !== null,
  };
}
