import { z } from "zod";

/** Request shapes for the `document` module's commands. Every schema is `.strict()`. */

const Code = z.string().trim().min(1).max(64);

export const CreateDocumentTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    /** Stable code a command refers to (`quote.default`), not the row id. */
    code: Code,
    /** Which entity this template renders. `Document` fits any document type. */
    entityType: Code,
    description: z.string().trim().max(2_000).optional(),
    subject: z.string().trim().max(255).optional(),
    body: z.string().trim().min(1).max(200_000),
    /** Rendering target: `html` bodies are escaped per placeholder, `text` bodies are not. */
    format: z.enum(["html", "text"]).default("html"),
    locale: z.string().trim().min(2).max(8).optional(),
    active: z.boolean().default(true),
    /** The template used when a caller does not name one. Only one default per entity type. */
    isDefault: z.boolean().default(false),
  })
  .strict();

export const UpdateDocumentTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    subject: z.string().trim().max(255).nullable().optional(),
    body: z.string().trim().min(1).max(200_000).optional(),
    format: z.enum(["html", "text"]).optional(),
    locale: z.string().trim().min(2).max(8).nullable().optional(),
    active: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

const PreviewData = z.record(z.string(), z.unknown());

/**
 * A render preview: either a stored template named by its code, or the draft body the designer is
 * editing right now. Both carry the data they are rendered against, so a preview never reads the
 * live catalog on its own.
 */
export const PreviewDocumentSchema = z.union([
  z
    .object({
      templateCode: Code,
      data: PreviewData,
    })
    .strict(),
  z
    .object({
      body: z.string().trim().min(1).max(200_000),
      subject: z.string().trim().max(255).optional(),
      format: z.enum(["html", "text"]).default("html"),
      data: PreviewData,
    })
    .strict(),
]);

export type CreateDocumentTemplateInput = z.infer<
  typeof CreateDocumentTemplateSchema
>;
export type UpdateDocumentTemplateInput = z.infer<
  typeof UpdateDocumentTemplateSchema
>;
export type PreviewDocumentInput = z.infer<typeof PreviewDocumentSchema>;
