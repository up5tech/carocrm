import { z } from 'zod';

/**
 * The named preference documents (PLAN_Phase_20_Settings_UX.md §5.9). A name not registered here is
 * refused, so the table stays a preferences store rather than becoming a second general-purpose blob
 * store; a new consumer (20.12's column sets and favorites ordering, the command palette's recents)
 * registers its schema here and needs no migration.
 *
 * Locale and timezone are deliberately absent: `PATCH /AppUser/me` already owns them, and two
 * resources for one value would disagree.
 */
export const PREFERENCE_SCHEMAS = {
  density: z.enum(['comfortable', 'compact']),
  listPageSize: z.number().int().min(10).max(100),
  defaultDashboard: z.string().min(1).max(36).nullable(),
  /** Entity name → the columns its list shows, in order; 20.12 consumes this. */
  columns: z.record(z.string().max(100), z.array(z.string().max(100)).max(60)).refine(
    (value) => Object.keys(value).length <= 200,
    { message: 'Too many entities in the column set.' },
  ),
  /** §5.3: entity → column name → pixel width, set by dragging a list header's right edge. */
  columnWidths: z.record(
    z.string().max(100),
    z.record(z.string().max(100), z.number().int().min(48).max(960)),
  ).refine((value) => Object.keys(value).length <= 200, { message: 'Too many entities in the column widths.' }),
  /** Record keys as `Entity:id`, in display order. */
  favorites: z.array(z.string().min(3).max(200)).max(500),
  lastVisited: z.array(z.string().min(1).max(200)).max(50),
  dismissedSetupSteps: z.array(z.string().min(1).max(64)).max(50),
  /** §4.10: the home setup banner can be dismissed per user; it is guidance, never a task list. */
  setupChecklistDismissed: z.boolean(),
} as const;

export type PreferenceName = keyof typeof PREFERENCE_SCHEMAS;

export const PREFERENCE_NAMES: readonly string[] = Object.keys(PREFERENCE_SCHEMAS);

export function preferenceSchema(name: string): z.ZodTypeAny | undefined {
  return (PREFERENCE_SCHEMAS as Record<string, z.ZodTypeAny | undefined>)[name];
}
