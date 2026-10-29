// Typed Core proxy client for the device-local Shadow timeline.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";

import { type ApiTarget, request } from "./client.ts";

export interface SpeechHistoryInput {
	end: string;
	limit?: number;
	offset?: number;
	start: string;
}
export interface SpeechSegment {
	endedAt: string;
	id: string;
	startedAt: string;
	text: string;
	timing: "segment" | "window";
}
export interface SpeechHistory {
	nextOffset: number | null;
	segments: SpeechSegment[];
	truncated?: boolean;
}

const speechInputSlots = z.object({
	start: z.unknown(),
	end: z.unknown(),
	limit: z.unknown(),
	offset: z.unknown(),
});
const speechCallable = z.function();
// Preserve native object admission; property reads follow the explicit key check.
const speechInputObject = z.custom<z.output<typeof speechInputSlots>>(
	(value) =>
		Object.call(undefined, value) === value &&
		!speechCallable.safeParse(value).success
);
const speechString = z.string();
const speechLimit = z.number().int().min(1).max(500);
const speechOffset = z.number().int().min(0).max(10_000);

/** Validated before privileged dispatch as well as at the Shadow endpoint. */
export function parseSpeechHistoryInput(
	value: Parameters<typeof speechInputObject.safeParse>[0]
): SpeechHistoryInput | null {
	const input = speechInputObject.safeParse(value);
	if (!input.success) {
		return null;
	}
	const record = input.data;
	if (
		Object.keys(record).some(
			(key) => !["start", "end", "limit", "offset"].includes(key)
		)
	) {
		return null;
	}
	const {
		start: rawStart,
		end: rawEnd,
		limit: rawLimit = 100,
		offset: rawOffset = 0,
	} = record;
	const parsedStart = speechString.safeParse(rawStart);
	const parsedEnd = speechString.safeParse(rawEnd);
	if (!(parsedStart.success && parsedEnd.success)) {
		return null;
	}
	const start = parsedStart.data;
	const end = parsedEnd.data;
	const parsedLimit = speechLimit.safeParse(rawLimit);
	const parsedOffset = speechOffset.safeParse(rawOffset);
	if (
		!(
			/^\d{4}-\d{2}-\d{2}T.*Z$/.test(start) &&
			/^\d{4}-\d{2}-\d{2}T.*Z$/.test(end)
		)
	) {
		return null;
	}
	const duration = Date.parse(end) - Date.parse(start);
	if (
		!Number.isFinite(duration) ||
		Date.parse(start) < 0 ||
		duration <= 0 ||
		duration > 86_400_000 ||
		!parsedLimit.success ||
		!parsedOffset.success
	) {
		return null;
	}
	return { start, end, limit: parsedLimit.data, offset: parsedOffset.data };
}

export function speechHistoryQuery(input: SpeechHistoryInput): string {
	const valid = parseSpeechHistoryInput(input);
	if (!valid) {
		throw new Error("Invalid speech history range.");
	}
	return new URLSearchParams({
		start: valid.start,
		end: valid.end,
		limit: String(valid.limit),
		offset: String(valid.offset),
	}).toString();
}

// Complete native Shadow transcript projection; retain each decoded row.
function shadowResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const speechSegmentFields = z.object({
	id: z.string(),
	startedAt: z.string(),
	endedAt: z.string(),
	text: z.string(),
	timing: z.enum(["segment", "window"]),
});
export const speechHistoryResponseSchema = shadowResponse(
	z.object({
		segments: z.array(shadowResponse(speechSegmentFields)),
		nextOffset: z.number().nullable(),
		truncated: z.boolean().optional(),
	})
);
// All ten serialized TimelineEntry fields, rather than the six UI display fields.
const timelineEntryFields = z.object({
	ts: z.number(),
	track: z.number(),
	event_type: z.string(),
	app_name: z.string().nullable(),
	bundle_id: z.string().nullable(),
	app_path: z.string().nullable(),
	window_title: z.string().nullable(),
	url: z.string().nullable(),
	display_id: z.number().nullable(),
	segment_file: z.string(),
});
export const timelineResponseSchema = shadowResponse(
	z.object({
		entries: z.array(shadowResponse(timelineEntryFields)).nullish(),
		count: z.number().optional(),
		error: z.string().optional(),
	})
);

/** The caller supplies the physical device's Core target; never infer a remote sensor. */
export function fetchSpeechHistory(
	target: ApiTarget,
	input: SpeechHistoryInput
): Promise<SpeechHistory> {
	return request(
		target,
		`/api/shadow/transcripts?${speechHistoryQuery(input)}`,
		{},
		speechHistoryResponseSchema
	);
}

/** A single timeline event returned by Shadow through Core. */
export interface TimelineEvent {
	app_name: string | null;
	event_type: string;
	track: number;
	ts: number;
	url: string | null;
	window_title: string | null;
}

/** Fetch timeline events in the trailing `rangeMinutes` window. */
export async function fetchTimeline(
	target: ApiTarget,
	rangeMinutes: number,
	signal?: AbortSignal
): Promise<TimelineEvent[]> {
	const now = Date.now() * 1000;
	const start = now - rangeMinutes * 60 * 1_000_000;
	const json = await request(
		target,
		`/api/shadow/timeline?start=${start}&end=${now}`,
		{ signal },
		timelineResponseSchema
	);
	return json.entries ?? [];
}
