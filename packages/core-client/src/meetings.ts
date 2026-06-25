// apps/desktop/src/lib/api/meetings.ts
//
// Typed client for the Core meeting-notes API (`/api/meetings/*`). Field names are
// snake_case to match Core's serde shapes exactly. The event SSE stream uses
// fetch + ReadableStream (not EventSource) so the bearer token can be attached —
// same approach as the monitors alert stream.

import { type ApiTarget, apiUrl, makeHeaders, request } from "./client.ts";

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
	const json = await request<{ meetings?: Meeting[] }>(target, "/api/meetings");
	return json.meetings ?? [];
}

export async function getMeeting(
	target: ApiTarget,
	id: string
): Promise<Meeting> {
	const json = await request<{ meeting?: Meeting; error?: string }>(
		target,
		`/api/meetings/${id}`
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
	const json = await request<{ meeting?: Meeting; error?: string }>(
		target,
		"/api/meetings",
		{ method: "POST", body: data }
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
	const json = await request<{ meeting?: Meeting; error?: string }>(
		target,
		`/api/meetings/${id}/finalize`,
		{ method: "POST" }
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
	await request(target, `/api/meetings/${id}`, { method: "DELETE" });
}

export interface Transcript {
	segments: Segment[];
	text: string;
}

export async function getTranscript(
	target: ApiTarget,
	id: string
): Promise<Transcript> {
	const json = await request<Transcript>(
		target,
		`/api/meetings/${id}/transcript`
	);
	return { segments: json.segments ?? [], text: json.text ?? "" };
}

export async function getDetectionConfig(
	target: ApiTarget
): Promise<DetectionConfig> {
	const json = await request<DetectionConfig>(
		target,
		"/api/meetings/detection-config"
	);
	return { enabled: json.enabled ?? true, apps: json.apps ?? [] };
}

export async function setDetectionConfig(
	target: ApiTarget,
	data: Partial<DetectionConfig>
): Promise<void> {
	await request(target, "/api/meetings/detection-config", {
		method: "PUT",
		body: data,
	});
}

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
	const resp = await fetch(apiUrl(target, "/api/meetings/stream"), {
		method: "GET",
		headers: makeHeaders(target.token),
		signal,
	});
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
					onEvent(JSON.parse(data) as MeetingEvent);
				} catch {
					// Ignore malformed frames; the next event self-heals the feed.
				}
			}
			buffer = buffer.slice(sep + SSE_FRAME_SEPARATOR.length);
			sep = buffer.indexOf(SSE_FRAME_SEPARATOR);
		}
	}
}
