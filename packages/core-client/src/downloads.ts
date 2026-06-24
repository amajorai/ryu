// apps/desktop/src/lib/api/downloads.ts
//
// Typed client for Core's global download center (#456). Core owns the lifecycle
// of every network artifact (models/engines/agents/tools/skills) and exposes it
// through one set of endpoints:
//   - GET  /api/downloads          : snapshot of all tracked downloads
//   - GET  /api/downloads/stream   : SSE — a full snapshot on connect, then deltas
//   - POST /api/downloads/:id/{pause,resume,retry,cancel}
//   - DELETE /api/downloads/:id    : clear (dismiss) a terminal entry
//
// Per the Core-vs-Gateway rule this is a Core feature (it decides *what runs*).
// Base URL + bearer always come from the node store via the shared client helpers.

import { type ApiTarget, apiUrl, makeHeaders, request } from "./client.ts";

/** Lifecycle state of a single download (mirrors Core's `DownloadState`). */
export type DownloadState =
	| "queued"
	| "active"
	| "paused"
	| "verifying"
	| "completed"
	| "failed"
	| "cancelled";

/** What kind of artifact a download fetches (mirrors Core's `DownloadKind`). */
export type DownloadKind =
	| "model"
	| "engine"
	| "agent"
	| "tool"
	| "skill"
	| "embedding"
	| "voice"
	| "media"
	| "other";

/** One download's full state — the shape served by the snapshot + SSE deltas. */
export interface DownloadTask {
	created_at: number;
	dest_path: string | null;
	error: string | null;
	etag?: string | null;
	id: string;
	kind: DownloadKind;
	label: string;
	received_bytes: number;
	retryable: boolean;
	speed_bps: number | null;
	state: DownloadState;
	total_bytes: number | null;
	updated_at: number;
	url: string | null;
}

/** A streamed download event, discriminated by `type`. */
export type DownloadEvent =
	| { type: "snapshot"; tasks: DownloadTask[] }
	| { type: "update"; task: DownloadTask }
	| { type: "removed"; id: string };

/** Terminal states never make further progress and can be cleared from the UI. */
export function isTerminal(state: DownloadState): boolean {
	return state === "completed" || state === "cancelled" || state === "failed";
}

/** States where the artifact is actively occupying a slot or queued for one. */
export function isInFlight(state: DownloadState): boolean {
	return state === "queued" || state === "active" || state === "verifying";
}

/** Fetch the current snapshot (used as a fallback / initial fill). */
export async function listDownloads(
	target: ApiTarget
): Promise<DownloadTask[]> {
	const data = await request<{ downloads: DownloadTask[] }>(
		target,
		"/api/downloads"
	);
	return data.downloads ?? [];
}

const control = (id: string, action: string) => (target: ApiTarget) =>
	request<{ ok: boolean }>(target, `/api/downloads/${id}/${action}`, {
		method: "POST",
	});

export const pauseDownload = (target: ApiTarget, id: string) =>
	control(id, "pause")(target);
export const resumeDownload = (target: ApiTarget, id: string) =>
	control(id, "resume")(target);
export const retryDownload = (target: ApiTarget, id: string) =>
	control(id, "retry")(target);
export const cancelDownload = (target: ApiTarget, id: string) =>
	control(id, "cancel")(target);

/** Clear (dismiss) a terminal download entry. */
export const clearDownload = (target: ApiTarget, id: string) =>
	request<{ ok: boolean }>(target, `/api/downloads/${id}`, {
		method: "DELETE",
	});

/**
 * Open the download SSE stream and invoke `onEvent` for each parsed event.
 *
 * Resolves when the stream closes; rejects if the request fails or the body
 * cannot be read. Pass a `signal` to disconnect (e.g. on node switch / unmount).
 * The first event is always a `snapshot`, so a late/reconnecting client
 * self-heals without a separate fetch.
 */
export async function streamDownloads(
	target: ApiTarget,
	onEvent: (event: DownloadEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	const resp = await fetch(apiUrl(target, "/api/downloads/stream"), {
		method: "GET",
		headers: makeHeaders(target.token),
		signal,
	});
	if (!resp.ok) {
		throw new Error(`downloads stream failed: ${resp.status}`);
	}
	if (!resp.body) {
		throw new Error("downloads stream returned no body");
	}

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const flush = (frame: string) => {
		const dataLines = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim());
		if (dataLines.length === 0) {
			return;
		}
		try {
			onEvent(JSON.parse(dataLines.join("\n")) as DownloadEvent);
		} catch {
			// Ignore malformed frames rather than aborting the whole stream.
		}
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let sep = buffer.indexOf("\n\n");
		while (sep !== -1) {
			flush(buffer.slice(0, sep));
			buffer = buffer.slice(sep + 2);
			sep = buffer.indexOf("\n\n");
		}
	}
	if (buffer.trim().length > 0) {
		flush(buffer);
	}
}
