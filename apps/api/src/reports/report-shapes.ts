import { z } from 'zod';

export const ReportVisibilitySchema = z.enum(['private', 'shared']);

export const ReportCreateSchema = z.object({
  name: z.string().trim().min(1).max(190),
  definition: z.unknown(),
  visibility: ReportVisibilitySchema.default('private'),
}).strict();

export const ReportUpdateSchema = z.object({
  name: z.string().trim().min(1).max(190).optional(),
  definition: z.unknown().optional(),
  visibility: ReportVisibilitySchema.optional(),
}).strict();

export const MAX_REPORTS = 200;
