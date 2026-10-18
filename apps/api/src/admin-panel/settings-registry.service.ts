import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import type { ZodTypeAny } from 'zod';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';

/**
 * Settings document registry (PLAN_Phase_20_Settings_UX.md §4.2, §7.2).
 *
 * The single place that answers "what settings documents exist, who may read and write them, and
 * what is valid". Documents stay in `app_settings` — one row per document — so this phase does not
 * introduce a second settings store.
 */

/** Visibility of a document, modelled on the upstream config-parameter levels (§2.1). */
export type SettingsLevel = 'public' | 'user' | 'admin' | 'sysAdmin';

export interface SettingsWarning {
  readonly code: string;
  readonly message: string;
}

/**
 * A settings document as the registry stores it. The value type is erased to `unknown` because the
 * registry holds documents of many shapes side by side; each registration narrows it back inside its
 * own schema, `defaults` and `write` closure, which is where the concrete type still documents
 * itself.
 */
export interface SettingsDocumentDefinition {
  /** Stable identifier used in routes and audit rows, e.g. `navigation`. */
  readonly name: string;
  /** The `app_settings.name` row. Defaults to `name`; only legacy documents need an override. */
  readonly row?: string;
  readonly group: string;
  readonly labelKey: string;
  readonly descriptionKey?: string;
  readonly readLevel: SettingsLevel;
  readonly writeLevel: SettingsLevel;
  readonly schema: Readonly<ZodTypeAny>;
  readonly defaults: unknown;
  /**
   * `envelope` stores `{version, value, updatedAt, updatedBy}`; `flat` keeps the value keys at the
   * top of the row so a service that predates this phase can still read it. `brand` and `i18n` are
   * flat for exactly that reason (§15.2 backward compatibility).
   */
  readonly storage: 'envelope' | 'flat';
  /**
   * When the document is owned by a module service, that service validates and writes the row. The
   * registry delegates instead of absorbing the module's rules (§7.1).
   */
  readonly write?: (patch: Record<string, unknown>) => Promise<unknown>;
  /** Non-blocking configuration problems, surfaced the same way Sales settings warnings are. */
  readonly warnings?: (value: unknown) => readonly SettingsWarning[];
}

export interface RegisteredDocument {
  readonly name: string;
  readonly row: string;
  readonly group: string;
  readonly labelKey: string;
  readonly descriptionKey: string | undefined;
  readonly readLevel: SettingsLevel;
  readonly writeLevel: SettingsLevel;
}

const SYS_ADMIN_ROLE = 'sysAdmin';

@Injectable()
export class SettingsRegistryService {
  private readonly documents = new Map<string, SettingsDocumentDefinition>();

  constructor(@Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope) {}

  register(definition: SettingsDocumentDefinition): void {
    if (this.documents.has(definition.name)) {
      throw new ValidationError(`Settings document "${definition.name}" is already registered.`, { name: definition.name });
    }
    this.documents.set(definition.name, definition);
  }

  get(name: string): SettingsDocumentDefinition {
    const definition = this.documents.get(name);
    if (!definition) {
      throw new ValidationError(`Unknown settings document "${name}".`, { name, known: [...this.documents.keys()] });
    }
    return definition;
  }

  has(name: string): boolean {
    return this.documents.has(name);
  }

  /** Registration order — the catalog `GET /Settings/documents` returns. */
  list(): RegisteredDocument[] {
    return [...this.documents.values()].map((definition) => ({
      name: definition.name,
      row: definition.row ?? definition.name,
      group: definition.group,
      labelKey: definition.labelKey,
      descriptionKey: definition.descriptionKey,
      readLevel: definition.readLevel,
      writeLevel: definition.writeLevel,
    }));
  }

  /** Documents the current caller may read; the catalog is filtered server-side, not in the SPA. */
  listVisible(): RegisteredDocument[] {
    return this.list().filter((document) => this.mayRead(document.readLevel));
  }

  isAdministrator(): boolean {
    return this.scope.isAdmin || this.scope.roleIds().includes(SYS_ADMIN_ROLE);
  }

  /**
   * `admin` and `sysAdmin` resolve to the same predicate today: the instance has one administrative
   * tier (`users.is_admin` / `sysAdmin` role) and no separate super-account field. The level is kept
   * in the contract so a second tier can be added without changing these endpoints. Recorded as a
   * deviation in `docs/compatibility/settings-ux.md`.
   */
  mayRead(level: SettingsLevel): boolean {
    switch (level) {
      case 'public':
        return true;
      case 'user':
        return this.scope.principal !== undefined;
      case 'admin':
      case 'sysAdmin':
        return this.isAdministrator();
    }
  }

  assertWriteAccess(definition: SettingsDocumentDefinition): void {
    if (!this.mayRead(definition.writeLevel)) {
      throw new AuthorizationDeniedError(`Administrator access is required to change "${definition.name}" settings.`, {
        document: definition.name,
        level: definition.writeLevel,
      });
    }
  }
}
