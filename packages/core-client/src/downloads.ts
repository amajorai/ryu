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

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "./client.ts";

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
	| "mcp"
	| "other";

/** Artifact role published by Core; older snapshots may omit it. */
export type DownloadRole =
	| "engine"
	| "chat_model"
	| "embedding_model"
	| "reranker_model"
	| "classifier_model"
	| "vision_adapter"
	| "draft_model"
	| "speech_model"
	| "voice_model"
	| "image_model"
	| "video_model"
	| "agent"
	| "tool"
	| "skill"
	| "plugin"
	| "plugin_model"
	| "mcp_server"
	| "extract"
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
	role?: DownloadRole;
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

const downloadTaskSchema = z.object({
	id: z.string(),
	kind: z.enum([
		"model",
		"engine",
		"agent",
		"tool",
		"skill",
		"embedding",
		"voice",
		"media",
		"mcp",
		"other",
	]),
	role: z
		.enum([
			"engine",
			"chat_model",
			"embedding_model",
			"reranker_model",
			"classifier_model",
			"vision_adapter",
			"draft_model",
			"speech_model",
			"voice_model",
			"image_model",
			"video_model",
			"agent",
			"tool",
			"skill",
			"plugin",
			"plugin_model",
			"mcp_server",
			"extract",
			"other",
		])
		.optional(),
	label: z.string(),
	url: z.string().nullable(),
	dest_path: z.string().nullable(),
	total_bytes: z.number().nullable(),
	received_bytes: z.number(),
	state: z.enum([
		"queued",
		"active",
		"paused",
		"verifying",
		"completed",
		"failed",
		"cancelled",
	]),
	error: z.string().nullable(),
	retryable: z.boolean(),
	speed_bps: z.number().nullable(),
	etag: z.string().nullish(),
	created_at: z.number(),
	updated_at: z.number(),
});
const downloadEventFieldsSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("snapshot"), tasks: z.array(downloadTaskSchema) }),
	z.object({ type: z.literal("update"), task: downloadTaskSchema }),
	z.object({ type: z.literal("removed"), id: z.string() }),
]);
// Keep native event/task references and future fields after validating the
// complete Core publisher contract at the decoded SSE boundary.
const downloadEventSchema = z.custom<
	z.output<typeof downloadEventFieldsSchema>
>((value) => downloadEventFieldsSchema.safeParse(value).success);

// Decode the complete snapshot/control publishers while keeping native task
// references, metadata and future fields. Older snapshots may omit downloads.
const downloadSnapshotFieldsSchema = z.object({
	downloads: z.array(downloadTaskSchema).nullish(),
});
export const downloadSnapshotResponseSchema = z.custom<
	z.output<typeof downloadSnapshotFieldsSchema>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		downloadSnapshotFieldsSchema.safeParse(value).success
);
const downloadControlFieldsSchema = z.object({ ok: z.boolean() });
export const downloadControlResponseSchema = z.custom<
	z.output<typeof downloadControlFieldsSchema>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		downloadControlFieldsSchema.safeParse(value).success
);

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
	const data = await request(
		target,
		"/api/downloads",
		{},
		downloadSnapshotResponseSchema
	);
	return data.downloads ?? [];
}

const control = (id: string, action: string) => (target: ApiTarget) =>
	request(
		target,
		`/api/downloads/${id}/${action}`,
		{
			method: "POST",
		},
		downloadControlResponseSchema
	);

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
	request(
		target,
		`/api/downloads/${id}`,
		{
			method: "DELETE",
		},
		downloadControlResponseSchema
	);

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
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/downloads/stream"),
		{
			method: "GET",
			headers: makeHeaders(target.token, target.userJwt),
			signal,
		}
	);
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
			onEvent(downloadEventSchema.parse(JSON.parse(dataLines.join("\n"))));
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
