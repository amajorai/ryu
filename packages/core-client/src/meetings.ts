// apps/desktop/src/lib/api/meetings.ts
//
// Typed client for the Core meeting-notes API (`/api/meetings/*`). Field names are
// snake_case to match Core's serde shapes exactly. The event SSE stream uses
// fetch + ReadableStream (not EventSource) so the bearer token can be attached —
// same approach as the monitors alert stream.

import { z } from "zod";
import {
	type AppJsonValue,
	appJsonValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "./client.ts";

export type MeetingStatus = "detected" | "recording" | "processing" | "done";
export type MeetingSource = "manual" | "auto";

export interface MeetingNotes {
	action_items: string[];
	decisions: string[];
	generated_at?: string;
	key_points: string[];
	model?: string;
	summary: string;
}

export interface Meeting {
	app?: string | null;
	created_at: string;
	/** Space document holding the editable notes markdown (set on finalize). */
	doc_id?: string | null;
	ended_at?: string | null;
	/** Notion-style glyph JSON (GlyphValue), when set. */
	icon?: AppJsonValue | null;
	id: string;
	notes?: MeetingNotes | null;
	participants: string[];
	source: MeetingSource;
	/** Space the finalized notes were saved into (set on finalize). */
	space_id?: string | null;
	started_at: string;
	status: MeetingStatus;
	title: string;
	updated_at: string;
}

export interface Segment {
	created_at: string;
	id: number;
	meeting_id: string;
	speaker?: string | null;
	t_offset_ms: number;
	text: string;
}

// Internally-tagged union mirroring Core's `MeetingEvent` (`{ "type": ... }`).
export type MeetingEvent =
	| { type: "detected"; app: string; title: string; detected_at: string }
	| { type: "started"; meeting: Meeting }
	| { type: "segment"; segment: Segment }
	| { type: "status"; meeting_id: string; status: MeetingStatus }
	| { type: "finalized"; meeting: Meeting };

export interface StartMeetingInput {
	app?: string;
	source?: MeetingSource;
	title?: string;
}

export interface DetectionConfig {
	apps: string[];
	enabled: boolean;
}

export async function listMeetings(target: ApiTarget): Promise<Meeting[]> {
	const json = await request(
		target,
		"/api/meetings",
		{},
		meetingListResponseSchema
	);
	return json.meetings ?? [];
}

export async function getMeeting(
	target: ApiTarget,
	id: string
): Promise<Meeting> {
	const json = await request(
		target,
		`/api/meetings/${id}`,
		{},
		meetingEnvelopeResponseSchema
	);
	if (!json.meeting) {
		throw new Error(json.error ?? "meeting not found");
	}
	return json.meeting;
}

export async function startMeeting(
	target: ApiTarget,
	data: StartMeetingInput = {}
): Promise<Meeting> {
	const json = await request(
		target,
		"/api/meetings",
		{ method: "POST", body: data },
		meetingEnvelopeResponseSchema
	);
	if (!json.meeting) {
		throw new Error(json.error ?? "failed to start meeting");
	}
	return json.meeting;
}

export async function finalizeMeeting(
	target: ApiTarget,
	id: string
): Promise<Meeting> {
	const json = await request(
		target,
		`/api/meetings/${id}/finalize`,
		{ method: "POST" },
		meetingEnvelopeResponseSchema
	);
	if (!json.meeting) {
		throw new Error(json.error ?? "failed to finalize meeting");
	}
	return json.meeting;
}

export async function deleteMeeting(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/meetings/${id}`,
		{ method: "DELETE" },
		meetingDeleteResponseSchema
	);
}

/** Rename a meeting (`POST /api/meetings/:id/title`; locks out auto-rename). */
export async function renameMeeting(
	target: ApiTarget,
	id: string,
	title: string
): Promise<Meeting> {
	const json = await request(
		target,
		`/api/meetings/${id}/title`,
		{ method: "POST", body: { title } },
		meetingEnvelopeResponseSchema
	);
	if (!json.meeting) {
		throw new Error(json.error ?? "failed to rename meeting");
	}
	return json.meeting;
}

/** Set or clear a meeting glyph (`POST /api/meetings/:id/icon`). */
export async function setMeetingIcon(
	target: ApiTarget,
	id: string,
	icon: Parameters<typeof JSON.stringify>[0]
): Promise<Meeting> {
	const json = await request(
		target,
		`/api/meetings/${id}/icon`,
		{ method: "POST", body: { icon } },
		meetingEnvelopeResponseSchema
	);
	if (!json.meeting) {
		throw new Error(json.error ?? "failed to set meeting icon");
	}
	return json.meeting;
}

export interface Transcript {
	segments: Segment[];
	text: string;
}

export async function getTranscript(
	target: ApiTarget,
	id: string
): Promise<Transcript> {
	const json = await request(
		target,
		`/api/meetings/${id}/transcript`,
		{},
		meetingTranscriptResponseSchema
	);
	return { segments: json.segments ?? [], text: json.text ?? "" };
}

export async function getDetectionConfig(
	target: ApiTarget
): Promise<DetectionConfig> {
	const json = await request(
		target,
		"/api/meetings/detection-config",
		{},
		meetingDetectionResponseSchema
	);
	return { enabled: json.enabled ?? true, apps: json.apps ?? [] };
}

export async function setDetectionConfig(
	target: ApiTarget,
	data: Partial<DetectionConfig>
): Promise<void> {
	await request(
		target,
		"/api/meetings/detection-config",
		{
			method: "PUT",
			body: data,
		},
		meetingDetectionResponseSchema
	);
}

const meetingStatusFields = z.enum([
	"detected",
	"recording",
	"processing",
	"done",
]);
const meetingNotesFields = z.object({
	summary: z.string(),
	key_points: z.array(z.string()),
	action_items: z.array(z.string()),
	decisions: z.array(z.string()),
	generated_at: z.string().optional(),
	model: z.string().optional(),
});
const meetingFields = z.object({
	id: z.string(),
	title: z.string(),
	title_custom: z.boolean().optional(),
	icon: appJsonValueSchema.nullable().optional(),
	app: z.string().nullable().optional(),
	source: z.enum(["manual", "auto"]),
	status: meetingStatusFields,
	started_at: z.string(),
	ended_at: z.string().nullable().optional(),
	participants: z.array(z.string()),
	notes: meetingNotesFields.nullable().optional(),
	space_id: z.string().nullable().optional(),
	doc_id: z.string().nullable().optional(),
	created_at: z.string(),
	updated_at: z.string(),
});
const meetingSegmentFields = z.object({
	id: z.number(),
	meeting_id: z.string(),
	t_offset_ms: z.number(),
	speaker: z.string().nullable().optional(),
	text: z.string(),
	created_at: z.string(),
});
// The complete existing Meeting/Segment owners also validate REST responses.
// Older-node absent fields retain the established public fallbacks/error phases.
function meetingResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const meetingResponseSchema = meetingResponse(meetingFields);
export const meetingListResponseSchema = meetingResponse(
	z.object({
		meetings: z.array(meetingResponseSchema).nullish(),
		error: z.string().optional(),
	})
);
export const meetingEnvelopeResponseSchema = meetingResponse(
	z.object({
		meeting: meetingResponseSchema.nullish(),
		error: z.string().optional(),
	})
);
export const meetingDeleteResponseSchema = meetingResponse(
	z.object({ ok: z.boolean() })
);
export const meetingTranscriptResponseSchema = meetingResponse(
	z.object({
		segments: z.array(meetingResponse(meetingSegmentFields)).nullish(),
		text: z.string().nullish(),
	})
);
export const meetingDetectionResponseSchema = meetingResponse(
	z.object({
		enabled: z.boolean().nullish(),
		apps: z.array(z.string()).nullish(),
	})
);

const meetingEventFields = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("detected"),
		app: z.string(),
		title: z.string(),
		detected_at: z.string(),
	}),
	z.object({ type: z.literal("started"), meeting: meetingFields }),
	z.object({ type: z.literal("segment"), segment: meetingSegmentFields }),
	z.object({
		type: z.literal("status"),
		meeting_id: z.string(),
		status: meetingStatusFields,
	}),
	z.object({ type: z.literal("finalized"), meeting: meetingFields }),
]);
const meetingEventResponse = z.custom<z.output<typeof meetingEventFields>>(
	(value) => meetingEventFields.safeParse(value).success
);

const SSE_FRAME_SEPARATOR = "\n\n";
const DATA_PREFIX = "data:";

/**
 * Open the meeting event SSE stream and invoke `onEvent` for every event.
 * Resolves when the stream ends or `signal` aborts; throws on a non-2xx connect
 * so the caller can reconnect.
 */
export async function streamMeetingEvents(
	target: ApiTarget,
	onEvent: (event: MeetingEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/meetings/stream"),
		{
			method: "GET",
			headers: makeHeaders(target.token, target.userJwt),
			signal,
		}
	);
	if (!(resp.ok && resp.body)) {
		throw new Error(`meeting stream failed: ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let sep = buffer.indexOf(SSE_FRAME_SEPARATOR);
		while (sep !== -1) {
			const frame = buffer.slice(0, sep);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith(DATA_PREFIX))
				.map((line) => line.slice(DATA_PREFIX.length).trim())
				.join("\n");
			if (data) {
				try {
					onEvent(meetingEventResponse.parse(JSON.parse(data)));
				} catch {
					// Ignore malformed frames; the next event self-heals the feed.
				}
			}
			buffer = buffer.slice(sep + SSE_FRAME_SEPARATOR.length);
			sep = buffer.indexOf(SSE_FRAME_SEPARATOR);
		}
	}
}
