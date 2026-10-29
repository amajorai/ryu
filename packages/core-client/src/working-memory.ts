// Typed client for Core's working-memory surface (`/api/memory/working`).
//
// Working memory is a small per-thread or per-resource scratchpad an agent keeps
// current and receives on every turn: a Markdown document (template mode) or a
// JSON object validated by a JSON Schema (schema mode). Core derives the owner
// from the caller, so these calls only ever reach the caller's own documents.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

/** Which partition a working-memory document belongs to. */
export type WorkingMemoryScope = "thread" | "resource";

/** How the scratchpad is shaped and how updates apply. */
export type WorkingMemoryMode = "template" | "schema";

/** JSON value accepted in schema-mode data and JSON Schemas. */
export type WorkingMemoryJson =
	| null
	| boolean
	| number
	| string
	| WorkingMemoryJson[]
	| { [key: string]: WorkingMemoryJson };

/** One stored working-memory document. */
export interface WorkingMemoryDocument {
	/** Markdown document (template mode). */
	content?: string;
	createdAt: number;
	/** Structured object (schema mode). */
	data?: Record<string, WorkingMemoryJson>;
	id: string;
	mode: WorkingMemoryMode;
	/** JSON Schema the data is validated against (schema mode). */
	schema?: Record<string, WorkingMemoryJson>;
	scope: WorkingMemoryScope;
	/** Template the document was seeded from (template mode). */
	template?: string;
	updatedAt: number;
	/** Monotonic revision, starting at 1. */
	version: number;
}

/** Addresses one working-memory document. */
export interface WorkingMemoryRef {
	/** Thread (conversation) id for `thread`, resource id for `resource`. */
	id: string;
	scope: WorkingMemoryScope;
}

/** A write to a working-memory document. */
export interface WorkingMemoryUpdate {
	/** Template mode: the complete replacement Markdown. */
	content?: string;
	/** Schema mode: a JSON merge patch (RFC 7386); `null` removes a key. */
	data?: Record<string, WorkingMemoryJson>;
	/** Fail with 409 unless the stored version matches (0 = must not exist). */
	expectedVersion?: number;
	/** Explicit mode; defaults to the stored mode, else inferred from the fields. */
	mode?: WorkingMemoryMode;
	/** Schema mode: replace the whole object instead of merging. */
	replace?: boolean;
	/** Schema to record (schema mode). */
	schema?: Record<string, WorkingMemoryJson>;
	/** Template to record (template mode). */
	template?: string;
}

const jsonValue: z.ZodType<WorkingMemoryJson> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number(),
		z.string(),
		z.array(jsonValue),
		z.record(z.string(), jsonValue),
	])
);
const jsonObject = z.record(z.string(), jsonValue);

const workingMemoryWire = z.object({
	scope: z.enum(["thread", "resource"]),
	id: z.string(),
	mode: z.enum(["template", "schema"]),
	content: z.string().nullish(),
	data: jsonObject.nullish(),
	template: z.string().nullish(),
	schema: jsonObject.nullish(),
	version: z.number(),
	created_at: z.number(),
	updated_at: z.number(),
});

const envelopeSchema = z.object({
	scope: z.enum(["thread", "resource"]),
	id: z.string(),
	working_memory: workingMemoryWire.nullable(),
});

const deleteSchema = z.object({ deleted: z.boolean() });

function toDocument(
	wire: z.output<typeof workingMemoryWire>
): WorkingMemoryDocument {
	const doc: WorkingMemoryDocument = {
		scope: wire.scope,
		id: wire.id,
		mode: wire.mode,
		version: wire.version,
		createdAt: wire.created_at,
		updatedAt: wire.updated_at,
	};
	if (wire.content != null) {
		doc.content = wire.content;
	}
	if (wire.data != null) {
		doc.data = wire.data;
	}
	if (wire.template != null) {
		doc.template = wire.template;
	}
	if (wire.schema != null) {
		doc.schema = wire.schema;
	}
	return doc;
}

function workingMemoryPath(ref: WorkingMemoryRef): string {
	const params = new URLSearchParams({ scope: ref.scope, id: ref.id });
	return `/api/memory/working?${params.toString()}`;
}

/** Read a working-memory document, or `null` when none has been stored yet. */
export async function getWorkingMemory(
	target: ApiTarget,
	ref: WorkingMemoryRef
): Promise<WorkingMemoryDocument | null> {
	const json = await request(
		target,
		workingMemoryPath(ref),
		undefined,
		envelopeSchema
	);
	return json.working_memory ? toDocument(json.working_memory) : null;
}

/**
 * Create or update a working-memory document. Template mode replaces
 * `content`; schema mode merge-patches `data` and validates it against the
 * schema. Throws an `ApiError` with status 400 on a schema violation and 409 on
 * an `expectedVersion` mismatch.
 */
export async function updateWorkingMemory(
	target: ApiTarget,
	ref: WorkingMemoryRef,
	update: WorkingMemoryUpdate
): Promise<WorkingMemoryDocument> {
	const json = await request(
		target,
		workingMemoryPath(ref),
		{
			method: "PUT",
			body: {
				mode: update.mode,
				content: update.content,
				data: update.data,
				template: update.template,
				schema: update.schema,
				replace: update.replace ?? false,
				expected_version: update.expectedVersion,
			},
		},
		envelopeSchema
	);
	if (!json.working_memory) {
		throw new Error("Core returned no working memory after an update");
	}
	return toDocument(json.working_memory);
}

/** Delete a working-memory document. Resolves to whether one existed. */
export async function deleteWorkingMemory(
	target: ApiTarget,
	ref: WorkingMemoryRef
): Promise<boolean> {
	const json = await request(
		target,
		workingMemoryPath(ref),
		{ method: "DELETE" },
		deleteSchema
	);
	return json.deleted;
}
