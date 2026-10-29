import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/meetings.ts
//
// Typed client for the Core meeting-notes API (`/api/meetings/*`). Field names are
// snake_case to match Core's serde shapes exactly. The event SSE stream uses
// fetch + ReadableStream (not EventSource) so the bearer token can be attached —
// same approach as the monitors alert stream.

import type {
	DetectionConfig,
	MeetingNotes,
	MeetingSource,
	MeetingStatus,
	Segment,
	StartMeetingInput,
	Transcript,
} from "@ryuhq/core-client/meetings.ts";
import { type ApiTarget, authenticatedFetch, request } from "./client.ts";
import { encodePathId } from "./path-id.ts";

export type {
	DetectionConfig,
	MeetingNotes,
	MeetingSource,
	MeetingStatus,
	Segment,
	StartMeetingInput,
	Transcript,
} from "@ryuhq/core-client/meetings.ts";

const notesResponseSchema = z.looseObject({
	action_items: z.array(z.string()),
	decisions: z.array(z.string()),
	generated_at: z.string().optional(),
	key_points: z.array(z.string()),
	model: z.string().optional(),
	summary: z.string(),
});
const meetingsResponseSchema = z.looseObject({
	app: z.union([z.null(), z.string()]).optional(),
	created_at: z.string(),
	doc_id: z.union([z.null(), z.string()]).optional(),
	ended_at: z.union([z.null(), z.string()]).optional(),
	icon: gatewayJsonValueSchema.optional(),
	id: z.string(),
	notes: z.union([z.null(), notesResponseSchema]).optional(),
	participants: z.array(z.string()),
	source: z.union([z.literal("manual"), z.literal("auto")]),
	space_id: z.union([z.null(), z.string()]).optional(),
	started_at: z.string(),
	status: z.union([
		z.literal("detected"),
		z.literal("recording"),
		z.literal("processing"),
		z.literal("done"),
	]),
	title: z.string(),
	title_custom: z.boolean().optional(),
	updated_at: z.string(),
});
const jsonResponseSchema = z.looseObject({
	meetings: z.array(meetingsResponseSchema).optional(),
});
const jsonResponseSchema2 = z.looseObject({
	meeting: meetingsResponseSchema.optional(),
	error: z.string().optional(),
});
const jsonResponseSchema3 = z.looseObject({
	meeting: meetingsResponseSchema.optional(),
	error: z.string().optional(),
});
const jsonResponseSchema4 = z.looseObject({
	meeting: meetingsResponseSchema.optional(),
	error: z.string().optional(),
});
const jsonResponseSchema5 = z.looseObject({
	meeting: meetingsResponseSchema.optional(),
	error: z.string().optional(),
});
const jsonResponseSchema6 = z.looseObject({
	meeting: meetingsResponseSchema.optional(),
	error: z.string().optional(),
});
const segmentsResponseSchema = z.looseObject({
	created_at: z.string(),
	id: z.number(),
	meeting_id: z.string(),
	speaker: z.union([z.null(), z.string()]).optional(),
	t_offset_ms: z.number(),
	text: z.string(),
});
const jsonResponseSchema7 = z.looseObject({
	segments: z.array(segmentsResponseSchema),
	text: z.string(),
});
const templatesResponseSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
});
const jsonResponseSchema8 = z.looseObject({
	templates: z.array(templatesResponseSchema).optional(),
});
const jsonResponseSchema9 = z.looseObject({
	apps: z.array(z.string()),
	enabled: z.boolean(),
});

export interface Meeting {
	app?: string | null;
	created_at: string;
	/** Space document holding the editable notes markdown (set on finalize). */
	doc_id?: string | null;
	ended_at?: string | null;
	/** Notion-style glyph from the shared GlyphPicker. */
	icon?: unknown | null;
	id: string;
	notes?: MeetingNotes | null;
	participants: string[];
	source: MeetingSource;
	/** Space the finalized notes were saved into (set on finalize). */
	space_id?: string | null;
	started_at: string;
	status: MeetingStatus;
	title: string;
	/** Whether the title was chosen by the user (locks out auto-rename). */
	title_custom?: boolean;
	updated_at: string;
}

// Internally-tagged union mirroring Core's `MeetingEvent` (`{ "type": ... }`).
export type MeetingEvent =
	| { type: "detected"; app: string; title: string; detected_at: string }
	| { type: "started"; meeting: Meeting }
	| { type: "segment"; segment: Segment }
	| { type: "status"; meeting_id: string; status: MeetingStatus }
	| { type: "finalized"; meeting: Meeting };

export async function listMeetings(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<Meeting[]> {
	const json = await request(
		target,
		"/api/meetings",
		{ signal },
		jsonResponseSchema
	);
	return json.meetings ?? [];
}

export async function getMeeting(
	target: ApiTarget,
	id: string
): Promise<Meeting> {
	const json = await request(
		target,
		`/api/meetings/${encodePathId(id)}`,
		undefined,
		jsonResponseSchema2
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
		jsonResponseSchema3
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
		`/api/meetings/${encodePathId(id)}/finalize`,
		{ method: "POST" },
		jsonResponseSchema4
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
		`/api/meetings/${encodePathId(id)}`,
		{ method: "DELETE" },
		gatewayJsonValueSchema
	);
}

/** Manually rename a meeting. Marks the title user-chosen so Core's auto-namer
 * never overwrites it. Returns the updated meeting. */
export async function renameMeeting(
	target: ApiTarget,
	id: string,
	title: string
): Promise<Meeting> {
	const json = await request(
		target,
		`/api/meetings/${encodePathId(id)}/title`,
		{ method: "POST", body: { title } },
		jsonResponseSchema5
	);
	if (!json.meeting) {
		throw new Error(json.error ?? "failed to rename meeting");
	}
	return json.meeting;
}

/** Set or clear a meeting's Notion-style glyph. Returns the updated meeting. */
export async function setMeetingIcon(
	target: ApiTarget,
	id: string,
	icon: unknown | null
): Promise<Meeting> {
	const json = await request(
		target,
		`/api/meetings/${encodePathId(id)}/icon`,
		{ method: "POST", body: { icon } },
		jsonResponseSchema6
	);
	if (!json.meeting) {
		throw new Error(json.error ?? "failed to set meeting icon");
	}
	return json.meeting;
}

export async function getTranscript(
	target: ApiTarget,
	id: string
): Promise<Transcript> {
	const json = await request(
		target,
		`/api/meetings/${encodePathId(id)}/transcript`,
		undefined,
		jsonResponseSchema7
	);
	return { segments: json.segments ?? [], text: json.text ?? "" };
}

export interface MeetingTemplate {
	id: string;
	name: string;
}

/** List the built-in notes templates (for the settings picker). */
export async function listMeetingTemplates(
	target: ApiTarget
): Promise<MeetingTemplate[]> {
	const json = await request(
		target,
		"/api/meetings/templates",
		undefined,
		jsonResponseSchema8
	);
	return json.templates ?? [];
}

export interface ImportMeetingInput {
	/** Optional transcription engine (`whisper` | `audiocpp` | `parakeet`). */
	engine?: string;
	/** Optional title; blank auto-names from the summary. */
	title?: string;
}

/**
 * Import an audio file (WAV v1) as a meeting: Core transcribes it window by
 * window through the same pipeline as a live recording, then finalizes (notes +
 * optional diarization). Uses a raw multipart POST since {@link request} is
 * JSON-only; the browser sets the multipart boundary when Content-Type is omitted.
 */
export async function importMeeting(
	target: ApiTarget,
	file: File | Blob,
	data: ImportMeetingInput = {}
): Promise<Meeting> {
	const form = new FormData();
	form.append("file", file, "import.wav");
	if (data.engine) {
		form.append("engine", data.engine);
	}
	if (data.title) {
		form.append("title", data.title);
	}
	const resp = await authenticatedFetch(target, "/api/meetings/import", {
		method: "POST",
		headers: { "Content-Type": null },
		body: form,
	});
	if (!resp.ok) {
		const text = await resp.text();
		let message = `import failed: ${resp.status}`;
		try {
			const parsed = z
				.object({ error: z.string().optional() })
				.parse(JSON.parse(text));
			if (parsed.error) {
				message = parsed.error;
			}
		} catch {
			// non-JSON body — keep the status message
		}
		throw new Error(message);
	}
	// SAFETY: On this successful native Meetings import route, import_meeting returns finalize_and_save JSON containing the serde-serialized Meeting; the built-in public mount forwards that body unchanged. This is the cooperative native route contract, not validation of arbitrary JSON.
	const json = JSON.parse(await resp.text()) as {
		meeting?: Meeting;
		error?: string;
	};
	if (!json.meeting) {
		throw new Error(json.error ?? "import failed");
	}
	return json.meeting;
}

export async function getDetectionConfig(
	target: ApiTarget
): Promise<DetectionConfig> {
	const json = await request(
		target,
		"/api/meetings/detection-config",
		undefined,
		jsonResponseSchema9
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
		gatewayJsonValueSchema
	);
}

/**
 * Subscribe to meeting events and invoke `onEvent` for every event. Resolves
 * when the stream ends or `signal` aborts.
 *
 * Meetings now runs out-of-process (`apps-store/meetings`); its live event feed
 * is no longer folded into Core's unified `/api/events/all`, so this opens the
 * sidecar's own SSE stream at `/api/meetings/stream` (reached over the node URL
 * via the sidecar's `public_mount`). `useMeetingStream` wraps this in a
 * reconnect loop, so a dropped stream reconnects on the next iteration.
 */
export async function streamMeetingEvents(
	target: ApiTarget,
	onEvent: (event: MeetingEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	const resp = await authenticatedFetch(target, "/api/meetings/stream", {
		method: "GET",
		headers: { Accept: "text/event-stream" },
		signal,
	});
	if (!(resp.ok && resp.body)) {
		throw new Error(`meeting events stream failed: ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	// SSE frames are separated by a blank line; each `data:` line carries the
	// JSON of one `MeetingEvent`.
	try {
		while (!signal?.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split("\n\n");
			buffer = frames.pop() ?? "";
			for (const frame of frames) {
				for (const line of frame.split("\n")) {
					if (signal?.aborted) {
						return;
					}
					const trimmed = line.trim();
					if (!trimmed.startsWith("data:")) {
						continue;
					}
					const payload = trimmed.slice("data:".length).trim();
					if (!payload) {
						continue;
					}
					try {
						// SAFETY: The native Meetings stream serializes its typed broadcast MeetingEvent enum with serde type/snake_case tags and native Meeting/Segment payloads; the public mount streams those bytes, and this reader skips comment/empty frames. Foreign forged JSON is not validated here.
						onEvent(JSON.parse(payload) as MeetingEvent);
					} catch {
						// Non-JSON keep-alive or partial frame — ignore; the feed self-heals.
					}
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
