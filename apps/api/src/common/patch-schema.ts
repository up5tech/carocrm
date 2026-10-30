/**
 * PATCH body schemas.
 *
 * zod 4 changed `.partial()`: a field that carries `.default()` (or `.prefault()`) still resolves to
 * its default when the key is absent. A PATCH body therefore arrived at the service holding values the
 * client never sent, and a deep merge wrote them over the stored ones — a `{ name }` rename reset a
 * mailbox to port 587, reactivated it, and cleared its signature.
 *
 * Every PATCH shape in this API is derived through `patchOf()`, which drops the default before making
 * the key optional, so "absent" stays absent. Strictness is inherited from the source schema
 * (`.extend()` keeps a `strict()` object strict, and a stripping object still strips) and a nested
 * object is patched key by key instead of being replaced wholesale.
 */
import { z } from 'zod';

/** One entry of a shape: what `z.object({ … })` stores for a key. */
type Field = z.ZodRawShape[string];

/** A field with its `.default()`/`.prefault()` wrapper removed, so an absent key cannot be filled. */
type WithoutDefault<T extends Field> =
  T extends z.ZodDefault<infer Inner extends Field>
    ? WithoutDefault<Inner>
    : T extends z.ZodPrefault<infer Inner extends Field>
      ? WithoutDefault<Inner>
      : T;

/** One field of a patch: optional, default-free, and itself a patch when it is an object. */
type PatchField<T extends Field> = WithoutDefault<T> extends z.ZodObject<infer Shape extends z.ZodRawShape>
  ? z.ZodOptional<PatchObject<Shape>>
  : z.ZodOptional<WithoutDefault<T>>;

type PatchObject<Shape extends z.ZodRawShape> = z.ZodObject<{
  [K in keyof Shape]: PatchField<Shape[K]>;
}>;

/** The PATCH form of an object schema: every key optional, no default able to fill an absent key. */
export type PatchOf<S extends z.ZodObject<z.ZodRawShape>> = PatchObject<S['shape']>;

function withoutDefault(field: Field): z.ZodTypeAny {
  if (field instanceof z.ZodDefault || field instanceof z.ZodPrefault) return field.unwrap() as z.ZodTypeAny;
  return field as z.ZodTypeAny;
}

function shapeOf(schema: z.ZodObject<z.ZodRawShape>): z.ZodRawShape {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const stripped = withoutDefault(field);
    // A nested object is patched, not replaced: `{ features: { x: true } }` must leave `y` alone.
    shape[key] = (stripped instanceof z.ZodObject ? patchOf(stripped as z.ZodObject<z.ZodRawShape>) : stripped).optional();
  }
  return shape;
}

export function patchOf<S extends z.ZodObject<z.ZodRawShape>>(schema: S): PatchOf<S> {
  // `.extend()` rebuilds the object with the source's own unknown-key policy, so a strict body stays
  // strict (an unknown key is still a 422) and a stripping body keeps stripping.
  return schema.extend(shapeOf(schema)) as unknown as PatchOf<S>;
}
