import { z } from "zod";
import { appJsonValueSchema } from "./app-request-json.ts";

/** Native create response: apps/core/src/server/uploads.rs:401–409.
 * Index status: apps/core/src/space_file_index.rs:319–331. Preserve future JSON
 * metadata and actual decoded refs rather than rebuilding the publisher. */
function preserveUpload<S extends z.ZodType>(schema: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appJsonValueSchema.safeParse(value).success &&
			schema.safeParse(value).success
	);
}
export const uploadIndexSchema = preserveUpload(
	z
		.looseObject({
			document_id: z.string(),
			state: z.enum(["pending", "indexed", "skipped", "failed"]),
			reason_code: z.string().nullable(),
			message: z.string().nullable(),
			backend_id: z.string().nullable(),
			backend_version: z.string().nullable(),
			chunk_count: z.number(),
			warnings: z.array(z.string()),
			updated_at: z.number(),
		})
		.catchall(appJsonValueSchema)
);
export const uploadPublisherSchema = preserveUpload(
	z
		.looseObject({
			id: z.string(),
			space_id: z.string(),
			file_name: z.string(),
			url: z.string(),
			size: z.number(),
			content_type: z.string(),
			index: uploadIndexSchema,
		})
		.catchall(appJsonValueSchema)
);
/** Older Core replies lacked metadata; both installed consumers deliberately
 * retain their nullish fallback fields. This is a compatibility view, distinct
 * from the full publisher, and validates every supplied known field. */
export const uploadLegacyViewSchema = preserveUpload(
	z
		.looseObject({
			id: z.string(),
			space_id: z.string().nullish(),
			file_name: z.string().nullish(),
			url: z.string(),
			size: z.number().nullish(),
			content_type: z.string().nullish(),
			index: uploadIndexSchema.optional(),
		})
		.catchall(appJsonValueSchema)
);
export type UploadPublisher = z.output<typeof uploadPublisherSchema>;
export type UploadLegacyView = z.output<typeof uploadLegacyViewSchema>;
/** Preserve historical native Error string coercion for truthy JSON error values. */
export const uploadErrorViewSchema = preserveUpload(
	z
		.looseObject({
			error: appJsonValueSchema.optional(),
		})
		.catchall(appJsonValueSchema)
);
