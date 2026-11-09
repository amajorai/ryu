// Wire schemas for the Recaps client (`recaps.ts`). They mirror the serde shapes
// of the `@ryu/meetings` sidecar (`apps-store/meetings/backend/src/recap/`);
// loose objects tolerate fields the server adds later.

import { z } from "zod";

/** Where a recap was started. Unknown values are stored as `manual`. */
export type RecapSource =
	| "phone"
	| "watch"
	| "action_button"
	| "shortcut"
	| "control"
	| "wear"
	| "reminder"
	| "hardware"
	| "manual";

export const recapActionItemSchema = z.object({
	due: z.string().nullable().optional(),
	owner: z.string().nullable().optional(),
	text: z.string(),
});

export const recapNotesSchema = z.looseObject({
	action_items: z.array(z.string()).default([]),
	action_items_detail: z.array(recapActionItemSchema).default([]),
	decisions: z.array(z.string()).default([]),
	key_points: z.array(z.string()).default([]),
	people: z.array(z.string()).default([]),
	summary: z.string(),
	title: z.string().nullable().optional(),
	topics: z.array(z.string()).default([]),
});

export const recapMetaSchema = z.looseObject({
	client_session_id: z.string(),
	confirmed_at: z.string().nullable().optional(),
	duration_ms: z.number().default(0),
	expected_chunks: z.number().nullable().optional(),
	local_day: z.string(),
	needs_confirm: z.boolean().default(false),
	owner_user_id: z.string(),
	partial: z.boolean().default(false),
	pinned: z.boolean().default(false),
	tz: z.string(),
});

export const recapSchema = z.looseObject({
	created_at: z.string(),
	ended_at: z.string().nullable().optional(),
	id: z.string(),
	kind: z.literal("recap"),
	notes: recapNotesSchema.nullable().optional(),
	recap: recapMetaSchema,
	source: z.string(),
	started_at: z.string(),
	status: z.enum(["detected", "recording", "processing", "done"]),
	title: z.string(),
	updated_at: z.string(),
});

export const recapUploadContractSchema = z.object({
	accepted: z.array(z.string()),
	max_chunk_bytes: z.number(),
	max_chunk_ms: z.number(),
	max_seq: z.number(),
	recommended_chunk_ms: z.number(),
});

export const startResponseSchema = z.object({
	recap: recapSchema,
	upload: recapUploadContractSchema,
});
export const envelopeSchema = z.object({ recap: recapSchema });
export const listSchema = z.object({
	next_cursor: z.string().nullable(),
	recaps: z.array(recapSchema),
});
export const detailSchema = z.object({
	recap: recapSchema,
	transcript: z.array(z.object({ t_offset_ms: z.number(), text: z.string() })),
});
export const chunkResultSchema = z.object({
	duplicate: z.boolean(),
	segment_id: z.number().nullable().optional(),
	seq: z.number(),
	status: z.enum(["transcribed", "skipped_silent", "skipped_client"]),
});
export const chunkStatusSchema = z.object({
	missing: z.array(z.number()),
	received: z.array(z.number()),
});
export const recapSettingsSchema = z.looseObject({
	consent: z
		.object({
			at: z.string(),
			model: z.string().default(""),
			processors: z.array(z.string()),
			version: z.number(),
		})
		.optional(),
	digest_notify: z.boolean(),
	digest_time: z.string(),
	/** Opt-in rolling summaries while recording (off by default). */
	interim: z.boolean().default(false),
	people: z.boolean(),
	retention: z.object({
		audio_days: z.number(),
		digests_days: z.number(),
		notes_days: z.number(),
		segments_days: z.number(),
	}),
	tz: z.string().optional(),
});
export const settingsViewSchema = z.object({
	consent_current: z.boolean(),
	consent_version: z.number(),
	enabled: z.boolean(),
	processors: z.array(z.string()),
	settings: recapSettingsSchema,
});
export const recapDigestSchema = z.looseObject({
	action_items_detail: z.array(
		z.object({
			due: z.string().nullable().optional(),
			recap_id: z.string(),
			text: z.string(),
		})
	),
	count: z.number(),
	date: z.string(),
	highlights: z.array(z.object({ recap_id: z.string(), text: z.string() })),
	recap_ids: z.array(z.string()),
	summary: z.string(),
	title: z.string(),
	topics: z.array(z.string()),
	total_duration_ms: z.number(),
	tz: z.string(),
});
export const digestEnvelopeSchema = z.object({
	digest: recapDigestSchema.nullable(),
});
export const searchSchema = z.object({
	results: z.array(
		z.object({
			local_day: z.string(),
			recap_id: z.string(),
			score: z.number(),
			snippet: z.string(),
			title: z.string(),
		})
	),
});
export const okSchema = z.looseObject({});
/** `GET /recaps/:id/interim`: a rolling summary held only while recording. */
export const recapInterimSchema = z.object({
	generated_at: z.string(),
	key_points: z.array(z.string()).default([]),
	speech_ms: z.number(),
	summary: z.string(),
});
export const interimViewSchema = z.object({
	interim: recapInterimSchema.nullable(),
	next_at_speech_ms: z.number(),
	refreshed: z.boolean(),
	speech_ms: z.number(),
});

export type Recap = z.infer<typeof recapSchema>;
export type RecapNotes = z.infer<typeof recapNotesSchema>;
export type RecapUploadContract = z.infer<typeof recapUploadContractSchema>;
export type RecapSettings = z.infer<typeof recapSettingsSchema>;
export type RecapSettingsView = z.infer<typeof settingsViewSchema>;
export type RecapDigest = z.infer<typeof recapDigestSchema>;
export type RecapSearchResult = z.infer<typeof searchSchema>["results"][number];
export type RecapChunkResult = z.infer<typeof chunkResultSchema>;
export type RecapInterim = z.infer<typeof recapInterimSchema>;
export type RecapInterimView = z.infer<typeof interimViewSchema>;
