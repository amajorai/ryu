import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import {
	parseRnpCapabilities,
	parseRnpWorkspaceInspection,
	parseRnpWorkspaceManifest,
	parseRnpWorkspaceResumeResult,
	RNP_WORKSPACE_FEATURE,
	type RnpBlobRefV0,
	type RnpContinuedOnV0,
	type RnpParseResult,
	type RnpWorkspaceDestinationV0,
	type RnpWorkspaceExportRequestV0,
	type RnpWorkspaceInspectionV0,
	type RnpWorkspaceManifestV0,
	type RnpWorkspaceResumeResultV0,
} from "@ryuhq/protocol/continuity";
import { z } from "zod";
import {
	ApiError,
	type ApiTarget,
	authenticatedFetch,
	request,
} from "./client.ts";

// RNP v0 working-tree handoff. Like the transcript transfer in
// `continuity.ts`, the desktop mediates every step and each request carries
// only its own node's credential: inspect/export/blob GET/continued go to the
// source, capabilities/blob HEAD+PUT/resume go to the destination. Core never
// calls another Core.

type JsonMethod = "DELETE" | "GET" | "POST";
type BlobMethod = "GET" | "HEAD" | "PUT";

export interface WorkspaceTransport {
	/** Raw blob request; resolves with the HTTP status (never throws on 4xx). */
	blob: (input: {
		body?: ArrayBuffer;
		method: BlobMethod;
		path: string;
		target: ApiTarget;
	}) => Promise<{ body?: ArrayBuffer; status: number }>;
	/** JSON request; rejects with an {@link ApiError} on a non-2xx response. */
	json: (input: {
		body?: unknown;
		method: JsonMethod;
		path: string;
		target: ApiTarget;
	}) => Promise<unknown>;
}

export interface WorkspaceRelayProgress {
	done: number;
	skipped: number;
	total: number;
}

export interface ContinueWorkspaceInput {
	/** Recorded on the source as "Continued on <nodeLabel>". */
	bundleId?: string;
	conversationId: string;
	destination: ApiTarget;
	destinationChoice: RnpWorkspaceDestinationV0;
	manifest: RnpWorkspaceManifestV0;
	nodeLabel: string;
	onProgress?: (progress: WorkspaceRelayProgress) => void;
	source: ApiTarget;
}

const continuedResponseSchema = z.object({
	continuedOn: z.unknown(),
});

function conversationPath(conversationId: string, suffix: string): string {
	return `/api/rnp/v0/conversations/${encodeURIComponent(conversationId)}/${suffix}`;
}

function blobPath(sha256: string): string {
	return `/api/rnp/v0/workspace-blobs/${encodeURIComponent(sha256)}`;
}

function unwrap<T>(parsed: RnpParseResult<T>, who: string): T {
	if (!parsed.ok) {
		throw new Error(
			`${who} returned an invalid response: ${parsed.error.message}`
		);
	}
	return parsed.value;
}

/** The node's own `error` text when it sent one, else a stable fallback. */
export function workspaceErrorMessage(
	error: unknown,
	fallback: string
): string {
	if (error instanceof ApiError) {
		return error.serverMessage ?? `${fallback} (${error.status})`;
	}
	return error instanceof Error ? error.message : fallback;
}

export function createWorkspaceContinuityClient(transport: WorkspaceTransport) {
	/** False when the destination predates working-tree handoff (404). */
	const probeCapabilities = async (
		destination: ApiTarget
	): Promise<boolean> => {
		try {
			const raw = await transport.json({
				target: destination,
				path: "/api/rnp/v0/capabilities",
				method: "GET",
			});
			const parsed = parseRnpCapabilities(raw);
			return parsed.ok && parsed.value.features.includes(RNP_WORKSPACE_FEATURE);
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) {
				return false;
			}
			throw error;
		}
	};

	const inspectWorkspace = async (
		source: ApiTarget,
		conversationId: string
	): Promise<RnpWorkspaceInspectionV0> => {
		const raw = await transport.json({
			target: source,
			path: conversationPath(conversationId, "workspace/inspect"),
			method: "POST",
			body: { version: 0 },
		});
		const inspection = unwrap(parseRnpWorkspaceInspection(raw), "The source");
		if (inspection.conversationId !== conversationId) {
			throw new Error("The source inspected a different conversation.");
		}
		return inspection;
	};

	const exportWorkspace = async (
		source: ApiTarget,
		conversationId: string,
		exportRequest: RnpWorkspaceExportRequestV0
	): Promise<RnpWorkspaceManifestV0> => {
		const raw = await transport.json({
			target: source,
			path: conversationPath(conversationId, "workspace/export"),
			method: "POST",
			body: exportRequest,
		});
		const manifest = unwrap(parseRnpWorkspaceManifest(raw), "The source");
		if (manifest.conversationId !== conversationId) {
			throw new Error("The source exported a different conversation.");
		}
		return manifest;
	};

	/**
	 * Copy each blob the manifest references from the source to the destination.
	 * A blob the destination already has (HEAD 200) is skipped, so a retry after a
	 * lost response resumes where it stopped.
	 */
	const relayWorkspaceBlobs = async (
		source: ApiTarget,
		destination: ApiTarget,
		manifest: RnpWorkspaceManifestV0,
		onProgress?: (progress: WorkspaceRelayProgress) => void
	): Promise<WorkspaceRelayProgress> => {
		const blobs: RnpBlobRefV0[] = [];
		if (manifest.commits) {
			blobs.push(manifest.commits.blob);
		}
		if (manifest.diff) {
			blobs.push(manifest.diff.blob);
		}
		const progress: WorkspaceRelayProgress = {
			done: 0,
			skipped: 0,
			total: blobs.length,
		};
		onProgress?.({ ...progress });
		for (const blob of blobs) {
			const path = blobPath(blob.sha256);
			const present = await transport.blob({
				target: destination,
				path,
				method: "HEAD",
			});
			if (present.status === 200) {
				progress.skipped += 1;
			} else {
				const download = await transport.blob({
					target: source,
					path,
					method: "GET",
				});
				if (download.status !== 200 || !download.body) {
					throw new Error(
						"The source no longer has the reviewed working tree. Review it again."
					);
				}
				if (download.body.byteLength !== blob.bytes) {
					throw new Error(
						"The source returned a working-tree blob of the wrong size."
					);
				}
				const upload = await transport.blob({
					target: destination,
					path,
					method: "PUT",
					body: download.body,
				});
				if (upload.status !== 200 && upload.status !== 201) {
					throw new Error(
						`The destination refused the working tree (${upload.status}).`
					);
				}
			}
			progress.done += 1;
			onProgress?.({ ...progress });
		}
		return progress;
	};

	const resumeWorkspace = async (
		destination: ApiTarget,
		manifest: RnpWorkspaceManifestV0,
		destinationChoice: RnpWorkspaceDestinationV0
	): Promise<RnpWorkspaceResumeResultV0> => {
		const raw = await transport.json({
			target: destination,
			path: conversationPath(manifest.conversationId, "workspace/resume"),
			method: "POST",
			body: { version: 0, manifest, destination: destinationChoice },
		});
		const result = unwrap(
			parseRnpWorkspaceResumeResult(raw),
			"The destination"
		);
		if (
			result.conversationId !== manifest.conversationId ||
			result.workspaceId !== manifest.workspaceId
		) {
			throw new Error("The destination resumed a different working tree.");
		}
		return result;
	};

	const markContinued = async (
		source: ApiTarget,
		conversationId: string,
		record: RnpContinuedOnV0
	): Promise<void> => {
		const raw = await transport.json({
			target: source,
			path: conversationPath(conversationId, "continued"),
			method: "POST",
			body: record,
		});
		continuedResponseSchema.parse(raw);
	};

	const clearContinued = async (
		source: ApiTarget,
		conversationId: string
	): Promise<void> => {
		const raw = await transport.json({
			target: source,
			path: conversationPath(conversationId, "continued"),
			method: "DELETE",
		});
		continuedResponseSchema.parse(raw);
	};

	/**
	 * Blob relay, then working-tree resume, then the source marking. The marking
	 * runs only after the destination rebuilt the tree, so a failed step never
	 * leaves the source saying the thread moved.
	 */
	const continueWorkspace = async (
		input: ContinueWorkspaceInput
	): Promise<RnpWorkspaceResumeResultV0> => {
		await relayWorkspaceBlobs(
			input.source,
			input.destination,
			input.manifest,
			input.onProgress
		);
		const result = await resumeWorkspace(
			input.destination,
			input.manifest,
			input.destinationChoice
		);
		const record: RnpContinuedOnV0 = {
			nodeLabel: input.nodeLabel,
			workspaceId: input.manifest.workspaceId,
			at: Date.now(),
		};
		if (input.bundleId) {
			record.bundleId = input.bundleId;
		}
		await markContinued(input.source, input.conversationId, record);
		return result;
	};

	return {
		clearContinued,
		continueWorkspace,
		exportWorkspace,
		inspectWorkspace,
		markContinued,
		probeCapabilities,
		relayWorkspaceBlobs,
		resumeWorkspace,
	};
}

// One JSON wrapper for every RNP JSON route. The transport only admits a JSON
// reply; each caller then validates its route's shape with the protocol
// parser (`parseRnp*`) or `continuedResponseSchema`.
function sendJson(input: {
	body?: unknown;
	method: JsonMethod;
	path: string;
	target: ApiTarget;
}): Promise<AppResponseValue> {
	return request(
		input.target,
		input.path,
		{ method: input.method, body: input.body },
		appResponseValueSchema
	);
}

async function sendBlob(input: {
	body?: ArrayBuffer;
	method: BlobMethod;
	path: string;
	target: ApiTarget;
}): Promise<{ body?: ArrayBuffer; status: number }> {
	const response = await authenticatedFetch(input.target, input.path, {
		method: input.method,
		body: input.body,
		headers:
			input.method === "PUT"
				? { "Content-Type": "application/octet-stream" }
				: undefined,
	});
	if (input.method !== "GET" || !response.ok) {
		await response.body?.cancel();
		return { status: response.status };
	}
	return {
		status: response.status,
		body: await response.arrayBuffer(),
	};
}

const workspaceClient = createWorkspaceContinuityClient({
	json: sendJson,
	blob: sendBlob,
});

export const probeRnpCapabilities = workspaceClient.probeCapabilities;
export const inspectRnpWorkspace = workspaceClient.inspectWorkspace;
export const exportRnpWorkspace = workspaceClient.exportWorkspace;
export const relayRnpWorkspaceBlobs = workspaceClient.relayWorkspaceBlobs;
export const resumeRnpWorkspace = workspaceClient.resumeWorkspace;
export const markRnpContinued = workspaceClient.markContinued;
export const clearRnpContinued = workspaceClient.clearContinued;
export const continueRnpWorkspace = workspaceClient.continueWorkspace;
