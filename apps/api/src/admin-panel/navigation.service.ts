import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { EXTENSION_HOST, type ExtensionHost } from '../extensions/extension-host.js';
import { I18nService } from '../i18n/i18n.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { NAVIGATION_ADMIN_ENTRIES, NAVIGATION_CONTAINER_GROUPS, NAVIGATION_PAGES, NAVIGATION_SALES_ENTITY_NAMES, NAVIGATION_SALES_GROUPS, NAVIGATION_SUBGROUPS, navigationProjectName, type NavigationSeed } from './navigation-defaults.js';
import { NAVIGATION_FEATURE_GATE, type NavigationFeatureGate } from './navigation-features.js';
import { knownEntryKeys, navigationWarnings } from './navigation-warnings.js';
import { SettingsDocumentService } from './settings-document.service.js';
import type { SettingsWarning } from './settings-registry.service.js';
import type { NavigationItem, NavigationSettings } from './settings-shapes.js';

/**
 * Navigation resolution (PLAN_Phase_20_Settings_UX.md §4.4, §7.2, §14).
 *
 * The pipeline never changes shape: shipped defaults → the `navigation` settings document → ACL
 * filtering → ordering. Running the ACL last is what makes the hard rule of §10 true — the document
 * can rename, move or hide an entry and can never add one the caller's roles refuse. One settings
 * read plus the request's single role snapshot; no query per menu item.
 */
export interface NavigationNode {
  readonly key: string;
  readonly kind: 'page' | 'entity' | 'group' | 'extension' | 'admin';
  readonly route: string;
  readonly label: string;
  readonly icon?: string;
  readonly accent?: string;
  readonly order: number;
  readonly inQuickSearch: boolean;
  readonly children?: readonly NavigationNode[];
}

export interface NavigationTree {
  readonly version: number;
  readonly items: readonly NavigationNode[];
  readonly warnings: readonly SettingsWarning[];
}

interface ResolvedEntity {
  readonly name: string;
  readonly label: string;
  readonly icon: string | undefined;
  readonly groupKey: string;
  readonly order: number;
}

const CACHE_MS = 30_000;

@Injectable()
export class NavigationService {
  private cache = new Map<string, { tree: NavigationTree; loadedAt: number }>();

  constructor(
    @Inject(METADATA_STORE) private readonly store: MetadataStoreService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EXTENSION_HOST) private readonly host: ExtensionHost,
    @Inject(I18nService) private readonly i18n: I18nService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(SettingsDocumentService) private readonly documents: SettingsDocumentService,
    @Inject(NAVIGATION_FEATURE_GATE) private readonly featureOn: NavigationFeatureGate,
  ) {
    // A menu edit has to show on the next render, not after the TTL expires.
    this.documents.onChanged((name) => {
      if (name === 'navigation') this.invalidate();
    });
  }

  /** The resolved tree for the principal of the current request. */
  async resolve(): Promise<NavigationTree> {
    // The metadata version is part of the key so an Entity Manager navigation edit shows on the next
    // request; a navigation document edit drops the whole cache through `onChanged`.
    const cacheKey = `${this.scope.userId ?? 'anonymous'}:${this.scope.userType ?? 'none'}:${this.store.version()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < CACHE_MS) return cached.tree;
    const tree = await this.build();
    this.cache.set(cacheKey, { tree, loadedAt: Date.now() });
    return tree;
  }

  /** Drop every cached menu — after a navigation write, a role change or a metadata edit. */
  invalidate(): void {
    this.cache = new Map();
  }

  private async build(): Promise<NavigationTree> {
    const document = await this.documents.readInternal('navigation');
    const value = document.value as NavigationSettings;
    const overrides = overrideIndex(value);
    const locale = this.scope.locale ?? (await this.i18n.settings()).defaultLocale;
    this.store.ensureLoaded();
    const warnings: SettingsWarning[] = navigationWarnings(value, {
      knownKeys: knownEntryKeys(
        this.store.registry.getEntities(),
        this.host.frontendNav().map((item) => `extension:${item.extension}:${item.route}`),
      ),
      entityExists: (name) => this.store.registry.hasEntity(name),
      labelKeyResolves: (key) => this.i18n.translate(locale, key) !== undefined,
    });

    /**
     * An administrator-set `labelKey` that does not resolve warns in the tab and falls back to the
     * platform label (§4.4); a platform label key with no translation is simply the untranslated
     * metadata label, which is not a configuration problem.
     */
    const labelOf = (key: string, seed: NavigationSeed): string => {
      const chosen = typeof overrides.get(key)?.['labelKey'] === 'string' ? (overrides.get(key)?.['labelKey'] as string) : seed.labelKey;
      if (chosen === undefined) return seed.label ?? key;
      const translated = this.i18n.translate(locale, chosen);
      if (translated !== undefined) return translated;
      if (typeof overrides.get(key)?.['labelKey'] === 'string') {
        warnings.push({ code: 'missingLabelKey', message: `"${overrides.get(key)?.['labelKey']}" is not a known translation key for "${key}".` });
        return seed.label ?? key;
      }
      return seed.label ?? chosen;
    };

    const members = new Map<string, NavigationSeed[]>();
    const push = (groupKey: string, seed: NavigationSeed): void => {
      const list = members.get(groupKey);
      if (list) list.push(seed);
      else members.set(groupKey, [seed]);
    };

    for (const entity of await this.navigableEntities()) {
      push(entity.groupKey, {
        key: `entity:${entity.name}`,
        kind: 'entity',
        route: `/${entity.name}`,
        label: entity.label,
        icon: entity.icon,
        labelKey: `crm.${entity.name.toLowerCase()}.label`,
        order: entity.order,
        inQuickSearch: true,
      });
    }
    for (const item of this.host.frontendNav()) {
      if (item.adminOnly && !this.scope.isAdmin) continue;
      push('extensions', { key: `extension:${item.extension}:${item.route}`, kind: 'extension', route: item.route, label: item.label, icon: item.icon, order: item.order });
    }
    for (const entry of NAVIGATION_ADMIN_ENTRIES) {
      if (entry.level === 'admin' && !this.scope.isAdmin) continue;
      push('administration', entry);
    }

    const buildNode = (seed: NavigationSeed, children?: NavigationNode[]): NavigationNode | null => {
      const override = overrides.get(seed.key);
      if (override?.['enabled'] === false) return null;
      const icon = typeof override?.['icon'] === 'string' ? override['icon'] : seed.icon;
      const accent = typeof override?.['accent'] === 'string' ? override['accent'] : undefined;
      const order = typeof override?.['order'] === 'number' ? override['order'] : seed.order;
      const inQuickSearch = typeof override?.['inQuickSearch'] === 'boolean' ? override['inQuickSearch'] : (seed.inQuickSearch ?? false);
      return {
        key: seed.key,
        kind: seed.kind,
        route: seed.route,
        label: labelOf(seed.key, seed),
        order,
        inQuickSearch,
        ...(icon === undefined ? {} : { icon }),
        ...(accent === undefined ? {} : { accent }),
        ...(children === undefined ? {} : { children }),
      };
    };

    const buildChildren = (groupKey: string): NavigationNode[] =>
      (members.get(groupKey) ?? [])
        .map((seed) => buildNode(seed))
        .filter((node): node is NavigationNode => node !== null)
        .sort(byOrder);

    // A page seed may name a module permission instead of a metadata entity (Phase 19-AI). ACL runs
    // last here too: the navigation document can rename or hide the entry but can never reveal a page
    // the caller's roles refuse.
    const items: NavigationNode[] = [];
    for (const page of NAVIGATION_PAGES) {
      if (page.permission !== undefined) {
        const level = await this.acl.canUser(page.permission.entity, page.permission.action);
        if (level === 'no') continue;
      }
      // A module page can also be switched off by a deployment flag (Phase 19-CHAT). Checked after
      // the ACL, so the flag can only remove an entry a role already allows — never add one.
      if (page.feature !== undefined && !(await this.featureOn(page.feature.module, page.feature.flag))) {
        continue;
      }
      const node = buildNode(page);
      if (node !== null) items.push(node);
    }

    for (const container of NAVIGATION_CONTAINER_GROUPS) {
      let children: NavigationNode[];
      if (container.key !== 'records') {
        children = buildChildren(container.key);
      } else {
        children = NAVIGATION_SUBGROUPS.map((subgroup) => {
          const membersOfSubgroup = buildChildren(subgroup.key);
          if (membersOfSubgroup.length === 0) return null;
          // The Project submenu is named after the Project record itself, as the sidebar has always done.
          const project = subgroup.key === 'project' ? membersOfSubgroup.find((node) => node.key === 'entity:Project') : undefined;
          const seed: NavigationSeed = {
            key: `group:${subgroup.key}`,
            kind: 'group',
            route: '',
            label: project?.label ?? subgroup.key,
            labelKey: project === undefined ? subgroup.labelKey : undefined,
            icon: project?.icon ?? subgroup.icon,
            order: subgroup.order,
          };
          return buildNode(seed, membersOfSubgroup.sort(byOrder));
        })
          .filter((node): node is NavigationNode => node !== null);
        const salesChildren = NAVIGATION_SALES_GROUPS.map((group, index) => {
          const inner = buildChildren(`sales:${group.key}`);
          if (inner.length === 0) return null;
          return buildNode({ key: `group:sales-${group.key}`, kind: 'group', route: '', labelKey: `sales.nav.${group.key}`, label: group.key, order: 171 + index }, inner);
        }).filter((node): node is NavigationNode => node !== null);
        if (salesChildren.length > 0) {
          const sales = buildNode({ key: 'group:sales', kind: 'group', route: '', labelKey: 'sales.nav.sales', label: 'Sales', icon: 'ShoppingCartOutlined', order: 170 }, salesChildren);
          if (sales) children.push(sales);
        }
        children.push(...buildChildren('records:none'));
      }
      if (children.length === 0) continue;
      const node = buildNode({ key: `group:${container.key}`, kind: 'group', route: '', labelKey: container.labelKey, label: container.key, icon: container.icon, order: container.order }, children.sort(byOrder));
      if (node) items.push(node);
    }

    return { version: document.version, items: items.sort(byOrder), warnings: dedupeWarnings(warnings) };
  }

  /**
   * Entities the caller may navigate: a record entity the web client shows, not hidden by its own
   * `nav` metadata, and readable by role. Sorted by label so the shipped order is the menu users had
   * before this phase.
   */
  private async navigableEntities(): Promise<ResolvedEntity[]> {
    this.store.ensureLoaded();
    const rows: Array<ResolvedEntity & { navOrder?: number }> = [];
    for (const name of this.store.registry.getEntities()) {
      const definition = this.store.registry.getEntity(name);
      if (!definition || definition.isEntity === false || definition.client?.web === false) continue;
      if (definition.nav?.hidden === true) continue;
      if ((await this.acl.canUser(name, 'read')) === 'no') continue;
      const order = definition.nav?.order;
      rows.push({
        name,
        label: definition.label ?? name,
        icon: definition.icon ?? undefined,
        groupKey: this.groupKeyFor(name, definition.nav?.group),
        order: 0,
        ...(typeof order === 'number' ? { navOrder: order } : {}),
      });
    }
    rows.sort((left, right) => left.label.localeCompare(right.label) || left.name.localeCompare(right.name));
    return rows.map((row, index) => ({ name: row.name, label: row.label, icon: row.icon, groupKey: row.groupKey, order: row.navOrder ?? 1000 + index }));
  }

  /** Metadata `nav.group` wins; otherwise the shipped name sets decide (§4.5). */
  private groupKeyFor(entityName: string, metadataGroup: string | null | undefined): string {
    if (typeof metadataGroup === 'string' && metadataGroup !== '') {
      if (metadataGroup.startsWith('sales-')) return `sales:${metadataGroup.slice('sales-'.length)}`;
      if (NAVIGATION_SUBGROUPS.some((group) => group.key === metadataGroup)) return metadataGroup;
    }
    if (navigationProjectName(entityName)) return 'project';
    if (NAVIGATION_SALES_ENTITY_NAMES.includes(entityName)) {
      const group = NAVIGATION_SALES_GROUPS.find((candidate) => candidate.entityNames.includes(entityName));
      return group === undefined ? 'records:none' : `sales:${group.key}`;
    }
    for (const subgroup of NAVIGATION_SUBGROUPS) {
      if (subgroup.entityNames.includes(entityName)) return subgroup.key;
    }
    return 'records:none';
  }
}

function byOrder(left: NavigationNode, right: NavigationNode): number {
  // §6.3: order decides, and a tie breaks on the key so the menu is deterministic.
  return left.order - right.order || left.key.localeCompare(right.key);
}

/**
 * Overrides are indexed by the entry key they name. `groups` entries are written with a bare key in
 * the document (`{"key": "Customers"}`) and address the `group:Customers` entry (§4.4).
 */
function overrideIndex(document: NavigationSettings): Map<string, NavigationItem> {
  const out = new Map<string, NavigationItem>();
  for (const item of document.items ?? []) out.set(item.key, item);
  for (const group of document.groups ?? []) {
    out.set(group.key.startsWith('group:') ? group.key : `group:${group.key}`, group);
  }
  return out;
}

function dedupeWarnings(warnings: readonly SettingsWarning[]): SettingsWarning[] {
  const seen = new Set<string>();
  const out: SettingsWarning[] = [];
  for (const warning of warnings) {
    const id = `${warning.code}:${warning.message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(warning);
  }
  return out;
}
