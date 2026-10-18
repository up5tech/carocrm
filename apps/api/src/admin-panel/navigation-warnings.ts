import { NAVIGATION_ADMIN_ENTRIES, NAVIGATION_CONTAINER_GROUPS, NAVIGATION_PAGES, NAVIGATION_SALES_GROUPS, NAVIGATION_SUBGROUPS } from './navigation-defaults.js';
import type { SettingsWarning } from './settings-registry.service.js';
import type { NavigationSettings } from './settings-shapes.js';

/**
 * Configuration problems in the `navigation` document (PLAN_Phase_20_Settings_UX.md §4.4, §11).
 *
 * These never block a save: an unknown key is ignored rather than refused, so a document written
 * before an upgrade keeps working, and the administrator is told about it in the tab's warning list
 * the same way Sales settings report a policy that needs attention.
 */

/** Every menu key the shipped defaults can produce, before the document is applied. */
export function knownEntryKeys(entityNames: Iterable<string>, extensionKeys: Iterable<string>): Set<string> {
  const out = new Set<string>([
    ...NAVIGATION_PAGES.map((page) => page.key),
    ...NAVIGATION_ADMIN_ENTRIES.map((entry) => entry.key),
    ...NAVIGATION_CONTAINER_GROUPS.map((group) => `group:${group.key}`),
    ...NAVIGATION_SUBGROUPS.map((group) => `group:${group.key}`),
    ...NAVIGATION_SALES_GROUPS.map((group) => `group:sales-${group.key}`),
    ...extensionKeys,
  ]);
  for (const name of entityNames) out.add(`entity:${name}`);
  return out;
}

const DECLARED_ITEM_KEYS = new Set(['key', 'enabled', 'order', 'labelKey', 'icon', 'accent', 'inQuickSearch']);

export interface NavigationWarningContext {
  readonly knownKeys: ReadonlySet<string>;
  /** Menu keys addressed by an `entity:<Name>` override must still exist (§11: no dead link). */
  readonly entityExists: (name: string) => boolean;
  readonly labelKeyResolves: (key: string) => boolean;
}

export function navigationWarnings(document: NavigationSettings, context: NavigationWarningContext): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  const seen = new Set<string>();
  const add = (code: string, message: string): void => {
    const id = `${code}:${message}`;
    if (seen.has(id)) return;
    seen.add(id);
    warnings.push({ code, message });
  };

  const entries = [
    ...(document.items ?? []).map((item) => ({ item, addressed: item.key })),
    ...(document.groups ?? []).map((item) => ({ item, addressed: item.key.startsWith('group:') ? item.key : `group:${item.key}` })),
  ];

  for (const { item, addressed } of entries) {
    for (const extra of Object.keys(item).filter((key) => !DECLARED_ITEM_KEYS.has(key))) {
      add('unrecognizedProperty', `"${extra}" on "${item.key}" is not a known menu property and is ignored.`);
    }
    if (!context.knownKeys.has(addressed)) {
      // An entity that left the metadata drops out of the menu silently — §11 says a dead link is
      // worse than a missing entry, so this is not reported as a configuration error.
      if (addressed.startsWith('entity:') && !context.entityExists(addressed.slice('entity:'.length))) continue;
      add('unknownKey', `"${item.key}" is not a menu entry of this instance, so the override is ignored.`);
      continue;
    }
    const labelKey = typeof item['labelKey'] === 'string' ? (item['labelKey'] as string) : undefined;
    if (labelKey !== undefined && !context.labelKeyResolves(labelKey)) {
      add('missingLabelKey', `"${labelKey}" is not a known translation key, so "${item.key}" keeps its default label.`);
    }
  }

  return warnings;
}
