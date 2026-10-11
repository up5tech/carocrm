import { z } from 'zod';

import { ValidationError } from '../errors/index.js';

export const idSchema = z.string().uuid();

export const emailSchema = z.string().email();

export const urlSchema = z.string().url();

export const phoneSchema = z.string().min(1);

export const paginationSchema = z.object({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(20),
});

export const sortSchema = z.object({
  field: z.string(),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details: Record<string, unknown> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      details[path] = issue.message;
    }
    throw new ValidationError('Validation failed.', details);
  }
  return result.data;
}

export async function validateAsync<T>(schema: z.ZodSchema<T>, data: unknown): Promise<T> {
  try {
    return await schema.parseAsync(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details: Record<string, unknown> = {};
      for (const issue of error.issues) {
        const path = issue.path.join('.');
        details[path] = issue.message;
      }
      throw new ValidationError('Validation failed.', details);
    }
    throw error;
  }
}