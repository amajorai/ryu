import type { LiteralMessage } from "@ryu/i18n/react";
import { type ApiTarget, request } from "./client.ts";
import type { RetrievalModeChange } from "./spaces.ts";
import { type RetrievalMode, toRetrievalMode } from "./spaces-types.ts";
import {
	retrievalModeCancelWireSchema,
	retrievalModeChangeWireSchema,
	retrievalModeJobWireSchema,
	retrievalModeStateSchema,
	retrievalModeStatusWireSchema,
} from "./spaces-wire-contracts.ts";

// apps/desktop/src/lib/api/spaces-retrieval-mode.ts
//
// Retrieval-mode switching: the background rebuild job and its summary. Split out of `spaces.ts`, which re-exports
// everything public here so its import path stays stable.

/** Live state reported while Core rebuilds a Space's retrieval graph. */
export interface RetrievalModeProgress {
	jobId: string;
	processedChunks: number;
	state: "running" | "cancelling" | "completed" | "cancelled" | "failed";
	totalChunks: number;
}

/** `1 entity` / `2 entities`, without pulling in an i18n dependency. */
function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * Plain-language summary of what a retrieval-mode switch did, for display next to
 * the control that caused it.
 *
 * Core also returns a prose `note`; this says the same thing plus the counts, so
 * the user learns whether the rebuild actually found anything. The empty-Space
 * case is called out separately on purpose: "mapped 0 entities across 0 chunks"
 * reads as a failure when it is the correct outcome for a Space with no documents.
 */
export function describeRetrievalModeChange(
	change: RetrievalModeChange,
	tl?: LiteralMessage
): string {
	if (!change.graphRebuilt) {
		return "Vector retrieval is on. The entity graph was discarded — switching back to Graph rebuilds it. Nothing was re-embedded.";
	}
	if (change.chunksScanned === 0) {
		return "Graph retrieval is on. This space has no documents yet, so there was nothing to map — documents will be mapped as you add them.";
	}
	if (tl) {
		// Counts go in preformatted: `#` would add digit grouping the English never had.
		return tl(
			"Graph retrieval is on. Mapped {nodes, plural, one {{nodesText} entity} other {{nodesText} entities}} and {edges, plural, one {{edgesText} connection} other {{edgesText} connections}} across {chunks, plural, one {{chunksText} chunk} other {{chunksText} chunks}} already in this space. Nothing was re-embedded.",
			{
				nodes: change.graphNodes,
				nodesText: String(change.graphNodes),
				edges: change.graphEdges,
				edgesText: String(change.graphEdges),
				chunks: change.chunksScanned,
				chunksText: String(change.chunksScanned),
			}
		);
	}
	return `Graph retrieval is on. Mapped ${plural(change.graphNodes, "entity", "entities")} and ${plural(change.graphEdges, "connection", "connections")} across ${plural(change.chunksScanned, "chunk", "chunks")} already in this space. Nothing was re-embedded.`;
}

interface RetrievalModeChangeWire {
	changed?: boolean;
	chunks_scanned?: number;
	graph_edges?: number;
	graph_nodes?: number;
	graph_rebuilt?: boolean;
	job_id?: string;
	mode?: string;
	note?: string;
	previous?: string;
	previous_retrieval_mode?: string;
	retrieval_mode?: string;
}

interface RetrievalModeStatusWire {
	change?: RetrievalModeChangeWire | null;
	error?: string | null;
	job_id: string;
	processed_chunks?: number;
	requested_mode?: string;
	space_id: string;
	state: RetrievalModeProgress["state"];
	total_chunks?: number;
}

const RETRIEVAL_MODE_MAX_POLLS = 7200;

class RetrievalModePollingTimeout extends Error {}

function isRetrievalModeWire(
	value: string | undefined
): value is RetrievalMode {
	return value === "vector" || value === "graph";
}

function isLegacyRetrievalModeChange(json: RetrievalModeChangeWire): boolean {
	return (
		isRetrievalModeWire(json.retrieval_mode ?? json.mode) &&
		isRetrievalModeWire(json.previous_retrieval_mode ?? json.previous) &&
		json.changed !== undefined &&
		json.graph_rebuilt !== undefined
	);
}

export interface SetRetrievalModeOptions {
	onProgress?: (progress: RetrievalModeProgress) => void;
	signal?: AbortSignal;
}

function toRetrievalModeChange(
	json: RetrievalModeChangeWire
): RetrievalModeChange {
	return {
		mode: toRetrievalMode(json.retrieval_mode ?? json.mode),
		previous: toRetrievalMode(json.previous_retrieval_mode ?? json.previous),
		changed: json.changed ?? false,
		graphRebuilt: json.graph_rebuilt ?? false,
		chunksScanned: json.chunks_scanned ?? 0,
		graphNodes: json.graph_nodes ?? 0,
		graphEdges: json.graph_edges ?? 0,
		note: json.note ?? "",
	};
}

function toRetrievalModeProgress(
	status: RetrievalModeStatusWire
): RetrievalModeProgress {
	return {
		jobId: status.job_id,
		state: status.state,
		processedChunks: status.processed_chunks ?? 0,
		totalChunks: status.total_chunks ?? 0,
	};
}

function waitForRetrievalModePoll(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const abort = () => {
			clearTimeout(timer);
			cleanup();
			reject(
				new DOMException(
					"The retrieval-mode rebuild was cancelled.",
					"AbortError"
				)
			);
		};
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const complete = () => {
			cleanup();
			resolve();
		};
		if (signal?.aborted) {
			abort();
			return;
		}
		timer = setTimeout(complete, 250);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/**
 * Change an existing Space's retrieval mode.
 *
 * This is a real re-index of the entity graph, not a flag flip. Core accepts it as
 * a background job and returns HTTP 202; this client polls until the job commits or
 * is cancelled. Callers should keep the control disabled while polling rather than
 * letting a second click queue a second full rebuild.
 *
 * Two consequences worth stating because they are not the usual HTTP intuitions:
 *
 * - **Aborting requests cancellation.** Once the job id is known, an aborted
 *   `AbortSignal` posts to the cancel endpoint; Core rolls back the staged swap
 *   and the previous mode remains active.
 * - **Progress is authoritative.** The local mode is patched only after a
 *   completed status includes the committed change; running and cancelled states
 *   never make an optimistic mode update.
 *
 * The mode this writes governs every search of the Space — {@link searchSpace} and
 * the automatic recall an agent does on a chat turn, which delegates to the same
 * Core function. See {@link Space.retrievalMode} for the two paths and where they
 * meet.
 */
export async function setSpaceRetrievalMode(
	target: ApiTarget,
	id: string,
	mode: RetrievalMode,
	options: SetRetrievalModeOptions = {}
): Promise<RetrievalModeChange> {
	const encodedSpaceId = encodeURIComponent(id);
	const json = retrievalModeChangeWireSchema.parse(
		await request(
			target,
			`/api/spaces/${encodedSpaceId}/retrieval-mode`,
			{
				method: "POST",
				body: { retrieval_mode: mode },
				// Core accepts this POST before it returns the job id. Do not let Stop
				// interrupt that small handoff: an aborted fetch can otherwise leave an
				// accepted rebuild running with no id for the cancellation path below.
			},
			retrievalModeChangeWireSchema
		)
	);
	// Keep accepting a completed response for older Core nodes, but the current
	// contract is 202 + a job id. The local Space mode is updated only after the
	// status endpoint reports `completed` and includes the committed change.
	if (json.job_id === undefined) {
		if (!isLegacyRetrievalModeChange(json)) {
			throw new Error("Core returned an invalid retrieval-mode response.");
		}
		return toRetrievalModeChange(json);
	}
	const parsedJob = retrievalModeJobWireSchema.safeParse(json);
	if (
		!parsedJob.success ||
		parsedJob.data.job_id.trim() === "" ||
		parsedJob.data.space_id !== id
	) {
		throw new Error("Core returned a retrieval-mode job for the wrong Space.");
	}
	const job = parsedJob.data;
	const statusPath = `/api/spaces/${encodedSpaceId}/retrieval-mode/status?job_id=${encodeURIComponent(job.job_id)}`;
	const cancelPath = `/api/spaces/${encodedSpaceId}/retrieval-mode/cancel`;
	const poll = async (signal?: AbortSignal): Promise<RetrievalModeChange> => {
		for (let attempt = 0; attempt < RETRIEVAL_MODE_MAX_POLLS; attempt += 1) {
			const status = retrievalModeStatusWireSchema.parse(
				await request(
					target,
					statusPath,
					{
						signal,
					},
					retrievalModeStatusWireSchema
				)
			);
			if (status.job_id !== job.job_id || status.space_id !== id) {
				throw new Error(
					"Core returned status for the wrong retrieval-mode job."
				);
			}
			const progressState = retrievalModeStateSchema.safeParse(status.state);
			if (!progressState.success) {
				throw new Error("Core returned an unknown retrieval-mode job state.");
			}
			options.onProgress?.(
				toRetrievalModeProgress({ ...status, state: progressState.data })
			);
			if (status.state === "completed") {
				if (!status.change) {
					throw new Error(
						"Core reported a completed retrieval-mode job without its committed change."
					);
				}
				return toRetrievalModeChange(status.change);
			}
			if (status.state === "cancelled") {
				throw new DOMException(
					"The retrieval-mode rebuild was cancelled.",
					"AbortError"
				);
			}
			if (status.state === "failed") {
				throw new Error(status.error ?? "The retrieval-mode rebuild failed.");
			}
			if (status.state !== "running" && status.state !== "cancelling") {
				throw new Error("Core returned an unknown retrieval-mode job state.");
			}
			await waitForRetrievalModePoll(signal);
		}
		throw new RetrievalModePollingTimeout(
			"Timed out waiting for the retrieval-mode rebuild."
		);
	};
	try {
		return await poll(options.signal);
	} catch (error) {
		const abortedByCaller =
			error instanceof DOMException &&
			error.name === "AbortError" &&
			options.signal?.aborted;
		if (abortedByCaller || error instanceof RetrievalModePollingTimeout) {
			const cancellation = retrievalModeCancelWireSchema.parse(
				await request(
					target,
					cancelPath,
					{
						method: "POST",
						body: { job_id: job.job_id },
					},
					retrievalModeCancelWireSchema
				)
			);
			// An accepted cancellation is asynchronous too: Core may acknowledge the
			// request before the worker reaches its terminal state. Keep observing the
			// job so the UI does not report cancellation while the rebuild is still
			// committing or rolling back.
			if (
				cancellation.cancelled === true ||
				cancellation.cancelled === false ||
				cancellation.finalizing === true
			) {
				return await poll();
			}
		}
		throw error;
	}
}
