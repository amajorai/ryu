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

import { type ApiTarget, request } from "./client.ts";
import { streamChannel } from "./eventStream.ts";

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

/** Fetch the durable "previous downloads" history (newest first). Survives
 *  restart, unlike the live snapshot which drops terminal tasks. Returns `[]` on
 *  any error (older Core without the endpoint). */
export async function listDownloadHistory(
	target: ApiTarget
): Promise<DownloadTask[]> {
	try {
		const data = await request<{ history: DownloadTask[] }>(
			target,
			"/api/downloads/history"
		);
		return data.history ?? [];
	} catch {
		return [];
	}
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
 * Subscribe to download-center events and invoke `onEvent` for each. The first
 * event is always a `snapshot` (Core sends it on connect), so a late or
 * reconnecting client self-heals. Resolves when `signal` aborts. Shares the
 * single multiplexed node connection (`/api/events/all`, see eventStream.ts).
 */
export function streamDownloads(
	target: ApiTarget,
	onEvent: (event: DownloadEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	return streamChannel(target, "downloads", onEvent, signal);
}
