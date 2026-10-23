import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { ProviderError } from '../advanced-integrations/provider-error.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { METADATA_STORE,type MetadataStoreService } from '../metadata/metadata-store.service.js';
import { ESignatureConnectionService } from './esignature-connection.service.js';
import { ESignatureConnectionGate } from './esignature-connection-gate.service.js';
import { signatureModuleDisabledError } from './esignature-errors.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import { toModuleError } from './providers/signature-provider.errors.js';
import type { ProviderTemplateDetail, ProviderTemplateSummary } from './providers/signature-provider.port.js';
import { SignatureProviderRegistry } from './providers/signature-provider.registry.js';
import { type AuditInput, SignatureAuditRepository } from './signature-audit.repository.js';
import type { SignatureConnection } from './signature-connection.repository.js';
import { SignatureConnectionRepository } from './signature-connection.repository.js';
import {
  type SignatureFieldMapping,
  type SignatureRoleMapping,
  type SignatureTemplateMapping,
  SignatureTemplateMappingRepository,
} from './signature-template-mapping.repository.js';

/**
 * Phase 19-ES.7 — the template catalog and the mapping validation
 * (`PLAN_Phase_19_ESignature.md` §6.7, §4.4, §5.2, §8.2, §18 `19-ES.7`).
 *
 * A provider template is a contract's skeleton: named roles that must be filled and tabs that must
 * carry values. The mapping says which CRM recipient fills each role and which CRM attribute may reach
 * each tab. Three properties make that safe, and all three are enforced here:
 *
 *  1. **The catalog is the provider's, per account.** A template id means something only inside the
 *     connection that owns it (plan §13 ES.7 acceptance). Every refresh and every detail read is scoped
 *     to one connection, and a mapping that names a template the connection's account does not have is
 *     refused when it is saved — not discovered at send time.
 *  2. **A mapping is validated against the live template.** An unknown role, an unknown tab, or a
 *     required role left unfilled is refused at save, so "the template changed" is an administrator's
 *     error message rather than a half-sent envelope.
 *  3. **A field reference is a field, not a path or an expression.** The repository already refuses
 *     anything expression-shaped; this service adds the part that needs the metadata: the source entity
 *     must exist, the field must exist on it, and its type must be one a signature tab can carry.
 *
 * **Nothing here writes a provider template.** The adapter has no method for it and plan §6.7 says a
 * future requirement would need its own review; the catalog is read-only by construction.
 */

/** The source field types a signature tab can carry. Everything else is refused, not coerced. */
export const MAPPABLE_SOURCE_FIELD_TYPES = [
  'varchar',
  'text',
  'email',
  'phoneNumber',
  'url',
  'date',
  'datetime',
  'int',
  'float',
  'currency',
  'bool',
  'enum',
] as const;

/**
 * The tab kinds a signer fills themselves.
 *
 * A required *signHere* tab is not a missing CRM value — it is where the signer signs. Treating it as
 * one would make every ordinary template unusable, so only data-bearing tabs are checked for a mapping.
 */
const SIGNER_FILLED_TABS = new Set(['signHere', 'initialHere', 'dateSigned', 'note', 'approve', 'decline']);

export interface TemplateCatalogResult {
  readonly connectionId: string;
  readonly environment: string;
  readonly refreshedAt: string;
  readonly templates: readonly ProviderTemplateSummary[];
  /** What the refresh says about the mappings already stored for this connection. */
  readonly mappings: readonly {
    readonly id: string;
    readonly name: string;
    readonly providerTemplateId: string;
    readonly presentInCatalog: boolean;
    readonly catalogName: string | null;
  }[];
}

export interface TemplateDetailView extends ProviderTemplateDetail {
  readonly connectionId: string;
  readonly environment: string;
}

/** Why a mapping cannot be saved (or used), as stable codes rather than prose an operator has to parse. */
export interface MappingProblem {
  readonly code:
    | 'no_source_entity'
    | 'unknown_source_entity'
    | 'unknown_field'
    | 'field_type_not_mappable'
    | 'unknown_role'
    | 'missing_role'
    | 'unknown_tab'
    | 'missing_required_tab'
    | 'duplicate_role'
    | 'duplicate_tab';
  readonly message: string;
  readonly where: string;
}

export interface MappingValidation {
  readonly valid: boolean;
  readonly problems: readonly MappingProblem[];
}

export interface MappingUsageCheck {
  readonly usable: boolean;
  /** Template roles the request does not fill. */
  readonly missingRoles: readonly string[];
  /** Required tabs whose mapped CRM value is absent. */
  readonly missingValues: readonly { readonly tabName: string; readonly crmField: string }[];
}

export interface MappingInput {
  readonly name: string;
  readonly mappingType?: 'workflow' | 'document_type' | 'process' | undefined;
  readonly connectionId: string;
  readonly providerTemplateId: string;
  readonly supportedSourceEntities: readonly string[];
  readonly roleMappings: readonly SignatureRoleMapping[];
  readonly fieldMappings: readonly SignatureFieldMapping[];
  readonly defaultSubject?: string | null | undefined;
  readonly defaultMessage?: string | null | undefined;
  readonly isActive?: boolean | undefined;
}

/** What a caller may hand `update`; every content field is optional and `connectionId` never changes. */
export interface MappingPatch {
  readonly name?: string | undefined;
  readonly mappingType?: 'workflow' | 'document_type' | 'process' | undefined;
  readonly providerTemplateId?: string | undefined;
  readonly supportedSourceEntities?: readonly string[] | undefined;
  readonly roleMappings?: readonly SignatureRoleMapping[] | undefined;
  readonly fieldMappings?: readonly SignatureFieldMapping[] | undefined;
  readonly defaultSubject?: string | null | undefined;
  readonly defaultMessage?: string | null | undefined;
  readonly isActive?: boolean | undefined;
}

@Injectable()
export class ESignatureTemplateService {
  constructor(
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(ESignatureSettingsService) private readonly settingsService: ESignatureSettingsService,
    @Inject(ESignatureConnectionGate) private readonly gate: ESignatureConnectionGate,
    @Inject(ESignatureConnectionService) private readonly connectionService: ESignatureConnectionService,
    @Inject(SignatureConnectionRepository) private readonly connections: SignatureConnectionRepository,
    @Inject(SignatureTemplateMappingRepository) private readonly mappings: SignatureTemplateMappingRepository,
    @Inject(SignatureProviderRegistry) private readonly providers: SignatureProviderRegistry,
    @Inject(SignatureAuditRepository) private readonly audit: SignatureAuditRepository,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // ---------------------------------------------------------------------------
  // the catalog
  // ---------------------------------------------------------------------------

  /**
   * Refresh the account's template catalog and report how the stored mappings line up with it.
   *
   * A mapping whose template disappeared is *reported*, not deleted: it is configuration an
   * administrator may want to re-point, and a silent delete would hide the reason a request can no
   * longer be prepared from it.
   */
  async refresh(connectionId: string): Promise<TemplateCatalogResult> {
    await this.assertManage();
    await this.gate.assertOperation('listTemplates');
    const connection = await this.requireConnection(connectionId);
    const adapter = this.providers.assertOperation(connection.providerKey, 'listTemplates');
    const context = await this.connectionService.contextFor(connection);
    let templates: readonly ProviderTemplateSummary[];
    try {
      templates = await adapter.listTemplates(context);
    } catch (error) {
      throw toModuleError(error, connection.providerKey);
    }
    const stored = await this.mappings.listForConnection(connection.id);
    return {
      connectionId: connection.id,
      environment: connection.environment,
      refreshedAt: new Date().toISOString(),
      templates,
      mappings: stored.map((mapping) => {
        const found = templates.find((template) => template.templateId === mapping.providerTemplateId);
        return {
          id: mapping.id,
          name: mapping.name,
          providerTemplateId: mapping.providerTemplateId,
          presentInCatalog: found !== undefined,
          catalogName: found?.name ?? null,
        };
      }),
    };
  }

  /** One template's roles and tabs, from the account that owns the connection. */
  async detail(connectionId: string, templateId: string): Promise<TemplateDetailView> {
    await this.assertManage();
    await this.gate.assertOperation('templateDetails');
    const connection = await this.requireConnection(connectionId);
    const detail = await this.liveDetail(connection, templateId);
    return { ...detail, connectionId: connection.id, environment: connection.environment };
  }

  // ---------------------------------------------------------------------------
  // mappings
  // ---------------------------------------------------------------------------

  async list(connectionId?: string): Promise<readonly SignatureTemplateMapping[]> {
    await this.assertManage();
    if (connectionId === undefined || connectionId.trim() === '') {
      // No "all connections" list: a template id is only meaningful inside its account, and a flat list
      // invites exactly the mix-up the acceptance criterion forbids.
      throw new ValidationError('A template mapping list names the connection it belongs to.');
    }
    return this.mappings.listForConnection(connectionId.trim());
  }

  async get(id: string): Promise<SignatureTemplateMapping> {
    await this.assertManage();
    return this.mappings.requireById(id);
  }

  /**
   * Create a mapping, validated against the live template and the metadata registry.
   *
   * Validation before the write is the whole point: a mapping that names a role the template does not
   * have, or a field the source entity does not carry, would otherwise fail at the moment of send — with
   * a contract on the line.
   */
  async create(input: MappingInput): Promise<SignatureTemplateMapping> {
    await this.assertManage();
    await this.gate.assertOperation('templateDetails');
    const connection = await this.requireConnection(input.connectionId);
    const detail = await this.liveDetail(connection, input.providerTemplateId);
    const validation = this.validateDefinition(input, detail);
    if (!validation.valid) throw this.refusal(validation);

    const created = await this.mappings.create({
      name: input.name,
      ...(input.mappingType === undefined ? {} : { mappingType: input.mappingType }),
      connectionId: connection.id,
      providerTemplateId: input.providerTemplateId,
      providerTemplateName: detail.name,
      supportedSourceEntities: input.supportedSourceEntities,
      roleMappings: input.roleMappings,
      fieldMappings: input.fieldMappings,
      ...(input.defaultSubject === undefined ? {} : { defaultSubject: input.defaultSubject }),
      ...(input.defaultMessage === undefined ? {} : { defaultMessage: input.defaultMessage }),
      isActive: input.isActive === true,
      ...(this.scope.userId === undefined ? {} : { createdById: this.scope.userId }),
    });
    await this.auditMapping('created', created);
    return created;
  }

  /** Edit a mapping. The template it names may change, and is re-validated when it does. */
  async update(
    id: string,
    input: { version: number; patch: MappingPatch },
  ): Promise<SignatureTemplateMapping> {
    await this.assertManage();
    const current = await this.mappings.requireById(id);
    const connection = await this.requireConnection(current.connectionId);
    const providerTemplateId = input.patch.providerTemplateId ?? current.providerTemplateId;
    const detail = await this.liveDetail(connection, providerTemplateId);
    const merged: MappingInput = {
      name: input.patch.name ?? current.name,
      connectionId: current.connectionId,
      providerTemplateId,
      supportedSourceEntities: input.patch.supportedSourceEntities ?? current.supportedSourceEntities,
      roleMappings: (input.patch.roleMappings ?? current.roleMappings) as readonly SignatureRoleMapping[],
      fieldMappings: (input.patch.fieldMappings ?? current.fieldMappings) as readonly SignatureFieldMapping[],
      ...(input.patch.defaultSubject === undefined ? {} : { defaultSubject: input.patch.defaultSubject }),
      ...(input.patch.defaultMessage === undefined ? {} : { defaultMessage: input.patch.defaultMessage }),
    };
    const validation = this.validateDefinition(merged, detail);
    if (!validation.valid) throw this.refusal(validation);

    const updated = await this.mappings.update(
      current.id,
      input.version,
      {
        ...(input.patch.name === undefined ? {} : { name: input.patch.name }),
        ...(input.patch.mappingType === undefined ? {} : { mappingType: input.patch.mappingType }),
        ...(input.patch.providerTemplateId === undefined ? {} : { providerTemplateId: input.patch.providerTemplateId }),
        providerTemplateName: detail.name,
        ...(input.patch.supportedSourceEntities === undefined ? {} : { supportedSourceEntities: input.patch.supportedSourceEntities }),
        ...(input.patch.roleMappings === undefined ? {} : { roleMappings: input.patch.roleMappings }),
        ...(input.patch.fieldMappings === undefined ? {} : { fieldMappings: input.patch.fieldMappings }),
        ...(input.patch.defaultSubject === undefined ? {} : { defaultSubject: input.patch.defaultSubject }),
        ...(input.patch.defaultMessage === undefined ? {} : { defaultMessage: input.patch.defaultMessage }),
        ...(input.patch.isActive === undefined ? {} : { isActive: input.patch.isActive }),
      },
      this.scope.userId,
    );
    await this.auditMapping('updated', updated);
    return updated;
  }

  async setActive(id: string, isActive: boolean): Promise<SignatureTemplateMapping> {
    await this.assertManage();
    const updated = await this.mappings.setActive(id, isActive, this.scope.userId);
    await this.auditMapping(isActive ? 'activated' : 'deactivated', updated);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // validation
  // ---------------------------------------------------------------------------

  /**
   * Whether a mapping can be saved (or is still usable), computed without any write.
   *
   * Exported behaviour through the service so a screen can show the problems while the administrator
   * edits, and so a test can assert a refusal without catching a thrown error.
   */
  validateDefinition(input: MappingInput, detail: ProviderTemplateDetail): MappingValidation {
    return validateMappingDefinition(input, detail, {
      hasEntity: (entity) => this.metadata.registry.hasEntity(entity),
      field: (entity, field) => this.sourceField(entity, field),
    });
  }

  /**
   * What a specific set of recipients and source values is missing for this mapping.
   *
   * ES.8's preview and ES.9's preparation call this: the plan asks for missing roles and fields to be
   * caught *before* send, and this is the one place that decides what "missing" means.
   */
  async checkUsage(
    mappingId: string,
    input: { providedRoles: readonly string[]; values: Readonly<Record<string, unknown>> },
  ): Promise<MappingUsageCheck> {
    await this.assertManage();
    return evaluateMappingUsage(await this.mappings.requireById(mappingId), input);
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /**
   * The template as the provider's account has it now.
   *
   * A template the account does not have is the administrator's mistake, so it is a validation failure
   * (`TEMPLATE_NOT_FOUND`) rather than a provider fault; everything else keeps the adapter boundary's
   * stable translation.
   */
  private async liveDetail(connection: SignatureConnection, templateId: string): Promise<ProviderTemplateDetail> {
    const adapter = this.providers.assertOperation(connection.providerKey, 'templateDetails');
    try {
      return await adapter.templateDetails(await this.connectionService.contextFor(connection), templateId);
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'NOT_FOUND') {
        throw new ValidationError('This connection’s provider account has no such template, so it cannot be mapped.', {
          code: 'TEMPLATE_NOT_FOUND',
          providerTemplateId: templateId,
          connectionId: connection.id,
        });
      }
      throw toModuleError(error, connection.providerKey);
    }
  }

  /** The metadata field a CRM reference names, or `undefined` when it does not exist. */
  private sourceField(entity: string, field: string): { type: string } | undefined {
    return this.metadata.registry.getField(entity, field);
  }


  private refusal(validation: MappingValidation): ValidationError {
    return new ValidationError('This template mapping is not valid for the provider template.', {
      problems: validation.problems,
    });
  }

  private async requireConnection(connectionId: string): Promise<SignatureConnection> {
    const found = await this.connections.findById(connectionId.trim());
    if (found === undefined) throw new ValidationError(`No signature connection "${connectionId}".`, { connectionId });
    return found;
  }

  /**
   * The guard for the whole surface.
   *
   * `templateMappingManage` is its own capability (plan §12), separate from `connectionManage`: the
   * person who maps a contract's fields is not necessarily the person who holds the provider credential.
   */
  private async assertManage(): Promise<void> {
    await this.permissions.assert('templateMappingManage');
    const view = await this.settingsService.read();
    if (view.settings.enabled !== true) throw signatureModuleDisabledError('ESignature');
    if (view.effective.templates !== true) throw signatureModuleDisabledError('ESignature.templates');
  }

  private async auditMapping(change: string, mapping: SignatureTemplateMapping): Promise<void> {
    await this.audit.append({
      action: 'templateMapping.changed',
      connectionId: mapping.connectionId,
      actor: this.actorRef(),
      detail: { change, mappingId: mapping.id, providerTemplateId: mapping.providerTemplateId },
    });
  }

  private actorRef(): NonNullable<AuditInput['actor']> {
    const id = this.scope.userId;
    return id === undefined || id === 'system' ? { type: 'system' } : { type: 'user', id };
  }
}

/**
 * What a concrete request is missing for this mapping: unfilled roles, and required tabs whose mapped
 * CRM value is blank. Pure, so the preview (ES.8) and the send path (ES.9) ask the same question.
 */
export function evaluateMappingUsage(
  mapping: Pick<SignatureTemplateMapping, 'roleMappings' | 'fieldMappings'>,
  input: { providedRoles: readonly string[]; values: Readonly<Record<string, unknown>> },
): MappingUsageCheck {
  const provided = new Set(input.providedRoles);
  const missingRoles = mapping.roleMappings.filter((role) => !provided.has(role.roleName)).map((role) => role.roleName);
  const missingValues = mapping.fieldMappings
    .filter((field) => field.required)
    .filter((field) => {
      const value = input.values[field.crmField];
      return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    })
    .map((field) => ({ tabName: field.tabName, crmField: field.crmField }));
  return { usable: missingRoles.length === 0 && missingValues.length === 0, missingRoles, missingValues };
}

/**
 * The rules a mapping must satisfy, as a pure function of the mapping, the provider's template and a
 * metadata lookup.
 */
export interface MappingMetadataLookup {
  readonly hasEntity: (entity: string) => boolean;
  readonly field: (entity: string, field: string) => { type: string } | undefined;
}

export function validateMappingDefinition(
  input: Pick<MappingInput, 'supportedSourceEntities' | 'roleMappings' | 'fieldMappings'>,
  detail: ProviderTemplateDetail,
  lookup: MappingMetadataLookup,
): MappingValidation {
  const problems: MappingProblem[] = [];
  const entities = input.supportedSourceEntities;
  if (entities.length === 0) {
    problems.push({ code: 'no_source_entity', message: 'Name at least one CRM source entity this mapping serves.', where: 'supportedSourceEntities' });
  }
  const templateRoles = new Set(detail.roles.map((role) => role.roleName));
  const templateTabs = new Map(detail.fields.map((field) => [field.tabLabel, field]));

  for (const entity of entities) {
    if (!lookup.hasEntity(entity)) {
      problems.push({ code: 'unknown_source_entity', message: `"${entity}" is not a metadata entity.`, where: entity });
    }
  }

  const seenRoles = new Set<string>();
  const mappedRoles = new Set<string>();
  input.roleMappings.forEach((role, index) => {
    const where = `roleMappings[${String(index)}]`;
    if (seenRoles.has(role.roleName)) {
      problems.push({ code: 'duplicate_role', message: `The template role "${role.roleName}" is mapped twice.`, where });
    }
    seenRoles.add(role.roleName);
    mappedRoles.add(role.roleName);
    if (!templateRoles.has(role.roleName)) {
      problems.push({ code: 'unknown_role', message: `The template has no role "${role.roleName}".`, where });
    }
    if (role.source === 'crmField' && role.crmField !== null) {
      problems.push(...fieldProblems(entities, role.crmField, `${where}.crmField`, lookup));
    }
  });
  for (const role of detail.roles) {
    if (role.required && !mappedRoles.has(role.roleName)) {
      problems.push({ code: 'missing_role', message: `The template requires the role "${role.roleName}", which no mapping fills.`, where: 'roleMappings' });
    }
  }

  const seenTabs = new Set<string>();
  input.fieldMappings.forEach((field, index) => {
    const where = `fieldMappings[${String(index)}]`;
    if (seenTabs.has(field.tabName)) {
      problems.push({ code: 'duplicate_tab', message: `The tab "${field.tabName}" is mapped twice.`, where });
    }
    seenTabs.add(field.tabName);
    const templateTab = templateTabs.get(field.tabName);
    if (templateTab === undefined) {
      problems.push({ code: 'unknown_tab', message: `The template has no tab "${field.tabName}".`, where });
    }
    problems.push(...fieldProblems(entities, field.crmField, `${where}.crmField`, lookup));
  });
  for (const tab of detail.fields) {
    if (!tab.required) continue;
    if (SIGNER_FILLED_TABS.has(tab.fieldType ?? '')) continue;
    if (!seenTabs.has(tab.tabLabel)) {
      problems.push({
        code: 'missing_required_tab',
        message: `The template requires a value for the tab "${tab.tabLabel}", which no field mapping fills.`,
        where: 'fieldMappings',
      });
    }
  }

  return { valid: problems.length === 0, problems };
}

function fieldProblems(
  entities: readonly string[],
  crmField: string,
  where: string,
  lookup: MappingMetadataLookup,
): MappingProblem[] {
  const problems: MappingProblem[] = [];
  for (const entity of entities) {
    const field = lookup.field(entity, crmField);
    if (field === undefined) {
      problems.push({ code: 'unknown_field', message: `"${entity}" has no field "${crmField}".`, where });
      continue;
    }
    if (!(MAPPABLE_SOURCE_FIELD_TYPES as readonly string[]).includes(field.type)) {
      problems.push({
        code: 'field_type_not_mappable',
        message: `"${entity}.${crmField}" is a "${field.type}" field, which a signature tab cannot carry.`,
        where,
      });
    }
  }
  return problems;
}
