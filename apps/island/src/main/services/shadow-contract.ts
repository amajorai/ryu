import type { SpeechHistory } from "@ryuhq/core-client/shadow";
import { z } from "zod";
import type {
	CaptureControl,
	ProactiveSuggestion,
	ShadowContext,
} from "../../shared/ipc.ts";

export const shadowContextSchema = z.object({
	app_name: z.string().nullable(),
	capture_active: z.boolean(),
	ocr_text: z.string().nullable(),
	ocr_timestamp_us: z.number().nullable(),
	paused: z.boolean(),
	selected_text: z.string().nullable(),
	timestamp_us: z.number().nullable(),
	window_title: z.string().nullable(),
}) satisfies z.ZodType<ShadowContext>;

export const proactiveSuggestionSchema = z.object({
	body: z.string().nullable(),
	confidence: z.number(),
	created_at: z.number(),
	disposition: z.enum(["push_now", "inbox_only", "drop"]),
	id: z.string(),
	metadata: z.record(z.string(), z.json()),
	suggestion_type: z.string(),
	title: z.string(),
}) satisfies z.ZodType<ProactiveSuggestion>;

export const proactiveResponseSchema = z.object({
	suggestions: z.array(proactiveSuggestionSchema).optional(),
});

export const captureControlSchema = z.object({
	app_allowlist: z.array(z.string()),
	paused: z.boolean(),
}) satisfies z.ZodType<CaptureControl>;

export const speechHistorySchema = z.object({
	nextOffset: z.number().nullable(),
	segments: z.array(
		z.object({
			endedAt: z.string(),
			id: z.string(),
			startedAt: z.string(),
			text: z.string(),
			timing: z.enum(["segment", "window"]),
		})
	),
	truncated: z.boolean().optional(),
}) satisfies z.ZodType<SpeechHistory>;
