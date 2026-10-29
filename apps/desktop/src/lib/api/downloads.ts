import {
	type DownloadEvent,
	type DownloadTask,
	downloadControlResponseSchema,
	downloadSnapshotResponseSchema,
} from "@ryuhq/core-client/downloads";
import { z } from "zod";
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

export type {
	DownloadEvent,
	DownloadKind,
	DownloadRole,
	DownloadState,
	DownloadTask,
} from "@ryuhq/core-client/downloads";
export { isInFlight, isTerminal } from "@ryuhq/core-client/downloads";

const downloadTaskSchema = z.custom<
	NonNullable<
		z.output<typeof downloadSnapshotResponseSchema>["downloads"]
	>[number]
>(
	(value) =>
		downloadSnapshotResponseSchema.safeParse({ downloads: [value] }).success
);
const downloadEventFields = z.discriminatedUnion("type", [
	z.object({ type: z.literal("snapshot"), tasks: z.array(downloadTaskSchema) }),
	z.object({ type: z.literal("update"), task: downloadTaskSchema }),
	z.object({ type: z.literal("removed"), id: z.string() }),
]);
const downloadEventSchema = z.custom<z.output<typeof downloadEventFields>>(
	(value) => downloadEventFields.safeParse(value).success
);

/** Fetch the current snapshot (used as a fallback / initial fill). */
export async function listDownloads(
	target: ApiTarget
): Promise<DownloadTask[]> {
	const data = await request(
		target,
		"/api/downloads",
		undefined,
		downloadSnapshotResponseSchema
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
		const data = await request(
			target,
			"/api/downloads/history",
			undefined,
			downloadHistorySchema
		);
		return data.history ?? [];
	} catch {
		return [];
	}
}

// ── Concurrency settings ────────────────────────────────────────────────────

/** How the parallel-download slot count is chosen (mirrors Core). */
export type ConcurrencyMode = "auto" | "manual";

/** The live settings view: the preference plus what it resolves to. */
export interface DownloadSettings {
	/** Slots actually in force right now (in auto, the tuner's current pick). */
	effective_slots: number;
	/** True when `RYU_MAX_CONCURRENT_DOWNLOADS` pins the value; writes are refused. */
	env_locked: boolean;
	manual_slots: number;
	max_slots: number;
	/** Best aggregate throughput observed, bytes/sec. `0` before anything ran. */
	measured_bps: number;
	min_slots: number;
	mode: ConcurrencyMode;
}

const downloadSettingsSchema = z
	.object({
		effective_slots: z.number(),
		env_locked: z.boolean(),
		manual_slots: z.number(),
		max_slots: z.number(),
		measured_bps: z.number(),
		min_slots: z.number(),
		mode: z.enum(["auto", "manual"]),
	})
	.passthrough();
const downloadHistorySchema = z
	.object({ history: z.array(downloadTaskSchema).optional() })
	.passthrough();
const clearHistorySchema = z
	.object({ cleared: z.number(), ok: z.boolean() })
	.passthrough();

export function getDownloadSettings(
	target: ApiTarget
): Promise<DownloadSettings> {
	return request(
		target,
		"/api/downloads/settings",
		undefined,
		downloadSettingsSchema
	);
}

export function setDownloadSettings(
	target: ApiTarget,
	mode: ConcurrencyMode,
	maxConcurrent?: number
): Promise<DownloadSettings> {
	return request(
		target,
		"/api/downloads/settings",
		{
			body: { max_concurrent: maxConcurrent, mode },
			method: "PUT",
		},
		downloadSettingsSchema
	);
}

async function acknowledged<T extends { ok: boolean }>(
	response: Promise<T>
): Promise<T> {
	const result = await response;
	if (!result.ok) {
		throw new Error("Download action was rejected by Core");
	}
	return result;
}

const control = (id: string, action: string) => (target: ApiTarget) =>
	acknowledged(
		request(
			target,
			`/api/downloads/${encodeURIComponent(id)}/${action}`,
			{
				method: "POST",
			},
			downloadControlResponseSchema
		)
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
	acknowledged(
		request(
			target,
			`/api/downloads/${encodeURIComponent(id)}`,
			{
				method: "DELETE",
			},
			downloadControlResponseSchema
		)
	);

/**
 * Empty the durable finished-downloads log.
 *
 * `clearDownload` drops a row from the live registry only; Core has already
 * written a copy of every finished download to `downloads-history.json`, and
 * that copy is what the downloads page's History section lists. Clearing one
 * without the other is why "Clear finished" could look like it did nothing.
 */
export const clearDownloadHistory = (target: ApiTarget) =>
	acknowledged(
		request(
			target,
			"/api/downloads/history",
			{
				method: "DELETE",
			},
			clearHistorySchema
		)
	);

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
	return streamChannel(
		target,
		"downloads",
		onEvent,
		signal,
		downloadEventSchema
	);
}
