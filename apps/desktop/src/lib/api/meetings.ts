// apps/desktop/src/lib/api/meetings.ts
//
// Typed client for the Core meeting-notes API (`/api/meetings/*`). Field names are
// snake_case to match Core's serde shapes exactly. The event SSE stream uses
// fetch + ReadableStream (not EventSource) so the bearer token can be attached —
// same approach as the monitors alert stream.

import {
	type ApiTarget,
	apiUrl,
	identityHeaders,
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

/** Manually rename a meeting. Marks the title user-chosen so Core's auto-namer
 * never overwrites it. Returns the updated meeting. */
export async function renameMeeting(
	target: ApiTarget,
	id: string,
	title: string
): Promise<Meeting> {
	const json = await request<{ meeting?: Meeting; error?: string }>(
		target,
		`/api/meetings/${id}/title`,
		{ method: "POST", body: { title } }
	);
	if (!json.meeting) {
		throw new Error(json.error ?? "failed to rename meeting");
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
	const json = await request<Transcript>(
		target,
		`/api/meetings/${id}/transcript`
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
	const json = await request<{ templates?: MeetingTemplate[] }>(
		target,
		"/api/meetings/templates"
	);
	return json.templates ?? [];
}

export interface ImportMeetingInput {
	/** Optional transcription engine (`whisper` | `parakeet`). */
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
	// Auth + identity headers, but NOT Content-Type — the browser sets the
	// multipart boundary itself when we pass a FormData body.
	const headers: Record<string, string> = { ...identityHeaders() };
	if (target.token) {
		headers.Authorization = `Bearer ${target.token}`;
	}
	const resp = await fetch(apiUrl(target, "/api/meetings/import"), {
		method: "POST",
		headers,
		body: form,
	});
	if (!resp.ok) {
		const text = await resp.text();
		let message = `import failed: ${resp.status}`;
		try {
			const parsed = JSON.parse(text) as { error?: string };
			if (parsed.error) {
				message = parsed.error;
			}
		} catch {
			// non-JSON body — keep the status message
		}
		throw new Error(message);
	}
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
	const resp = await fetch(apiUrl(target, "/api/meetings/stream"), {
		method: "GET",
		headers: { ...makeHeaders(target.token), Accept: "text/event-stream" },
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
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const frames = buffer.split("\n\n");
		buffer = frames.pop() ?? "";
		for (const frame of frames) {
			for (const line of frame.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) {
					continue;
				}
				const payload = trimmed.slice("data:".length).trim();
				if (!payload) {
					continue;
				}
				try {
					onEvent(JSON.parse(payload) as MeetingEvent);
				} catch {
					// Non-JSON keep-alive or partial frame — ignore; the feed self-heals.
				}
			}
		}
	}
}
