import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

/** Validate the complete declared HTTP publisher without projecting or copying
 * its original reply, including future native JSON metadata. */
function nativeResponse<
	S extends z.ZodObject | z.ZodUnion<readonly z.ZodObject[]>,
>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

// Core get_preference publishes key even when a missing value is null.
export const corePreferenceResponseSchema = nativeResponse(
	z.object({
		key: z.string(),
		value: z.string().nullable(),
	})
);
export const coreMemorySettingsResponseSchema = nativeResponse(
	z.object({
		include_sensitive_topics: z.boolean(),
	})
);

// LongTermEntry and MemoryProvenance are the complete decrypted Rust publishers.
// Nullable confidence also admits native
// serde_json serialization of a non-finite optional f32.
const memoryProvenanceFields = z.object({
	source: z.string(),
	conversation_id: z.string().optional(),
	message_ids: z.array(z.string()).optional(),
	memory_ids: z.array(z.string()).optional(),
	confidence: z.number().nullable().optional(),
});
const memoryEntryFields = z.object({
	id: z.string(),
	content: z.string(),
	scope: z.string(),
	scope_id: z.string().nullable(),
	category: z.string(),
	importance: z.number(),
	when_to_use: z.string().nullable(),
	tags: z.array(z.string()),
	author_agent_id: z.string().nullable(),
	owner_user_id: z.string().nullable(),
	provenance: memoryProvenanceFields,
	sensitive_topics: z.array(z.string()).optional(),
	lifecycle: z.string(),
	supersedes_id: z.string().optional(),
	created_at: z.number(),
	updated_at: z.number(),
});
export type CoreMemoryEntry = z.output<typeof memoryEntryFields>;
export const coreMemoryListResponseSchema = nativeResponse(
	z.object({
		memories: z.array(memoryEntryFields),
	})
);
export const coreMemoryEntryResponseSchema = nativeResponse(
	z.object({
		memory: memoryEntryFields,
	})
);
// A successful creation can publish only its new id when immediate lookup fails.
export const coreMemoryWriteResponseSchema = nativeResponse(
	z.union([
		z.object({ memory: memoryEntryFields }),
		z.object({ id: z.string(), memory: z.never().optional() }),
	])
);

// data_admin::get_data_counts retains all five legacy counts plus app categories.
const dataCategoryFields = z.object({
	id: z.string(),
	title: z.string(),
	noun: z.string(),
	confirm_word: z.string(),
	detail: z.string(),
	count: z.number(),
	plugin: z.string().nullable(),
});
export const coreDataCountsResponseSchema = nativeResponse(
	z.object({
		chats: z.number(),
		spaces: z.number(),
		memory: z.number(),
		monitors: z.number(),
		meetings: z.number(),
		categories: z.array(dataCategoryFields).optional(),
	})
);

// packages/api/src/routers/profile.ts PUT /name publishes all three fields.
export const profileNameResponseSchema = nativeResponse(
	z.object({
		success: z.literal(true),
		message: z.string(),
		name: z.string(),
	})
);
