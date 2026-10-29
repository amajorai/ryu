// apps/desktop/src/lib/api/audio.ts
//
// Typed client for Core's music and sound-effect generation data path
// (`POST /api/audio/generate`, polled through `GET /api/audio/jobs/:id`).
//
// Core has no local audio-generation engine: every request names a cloud
// `provider` (Fal or Replicate) and its `model`, and Core submits a Gateway job.
// The Gateway normalizes a finished job to `{ id, status, data: [{ url }] }`, the
// same envelope a video job uses. A failed, cancelled or empty job throws with
// the upstream reason instead of resolving to silence.

import {
	type RpcJsonResponse,
	type RyuJsonValue,
	rpcJsonResponseSchema,
} from "@ryu/app-host/rpc";
import { z } from "zod";
import { type ApiTarget, authenticatedFetch } from "./client.ts";

/** One generated audio file, ready for an `<audio src>`. */
export interface GeneratedAudio {
	/** The provider's declared MIME type, or the URL's own `data:` type. */
	mediaType: string;
	/** A `data:` or `https:` URL. */
	url: string;
}

/** What to generate. `provider` and `model` are required because there is no
 *  local engine to fall back to. */
export interface GenerateAudioRequest {
	/** Host attribution for app-level generation ACLs. */
	appId?: string;
	/** Human-facing app permission required for this host-direct call. */
	appPermission?: string;
	/** Requested length in seconds, for `$duration_s` references. */
	durationS?: number;
	kind: "music" | "sfx";
	model: string;
	/** Poll interval while the job runs, in ms. Default: 3000. */
	pollIntervalMs?: number;
	prompt: string;
	provider: string;
	/** Model-specific fields Core merges into the provider body. */
	providerInput?: Record<string, RyuJsonValue>;
	/** Correlates this generation with an app-owned Gateway audit request. */
	requestId?: string;
	/** Give up after this many ms. Default: 600000 (10 min). */
	timeoutMs?: number;
}

interface AudioGenerationWireRequest {
	duration_s?: number;
	kind: "music" | "sfx";
	model: string;
	prompt: string;
	provider: string;
	provider_input?: Record<string, RyuJsonValue>;
	request_id?: string;
}

const optionalText = z.string().optional().catch(undefined);
const audioEntrySchema = z
	.object({
		url: optionalText,
		mediaType: optionalText,
		mime_type: optionalText,
		content_type: optionalText,
	})
	.catch({});
const audioOutputSchema = z
	.object({ data: z.array(audioEntrySchema).optional().catch(undefined) })
	.catch({});
const audioJobSchema = z
	.object({
		id: optionalText,
		status: optionalText,
		error: rpcJsonResponseSchema.optional(),
	})
	.catch({});
const audioFailureSchema = z
	.object({ error: rpcJsonResponseSchema.optional() })
	.catch({});

const TERMINAL_FAILURES = new Set([
	"failed",
	"canceled",
	"cancelled",
	"expired",
]);
const TERMINAL_SUCCESSES = new Set(["succeeded", "completed"]);
const DATA_URI_TYPE = /^data:([a-z]+\/[a-z0-9.+-]+)[;,]/iu;

/** Project the renderable files out of a finished job body. */
export function audioClipsFromBody(body: RpcJsonResponse): GeneratedAudio[] {
	const clips: GeneratedAudio[] = [];
	for (const entry of audioOutputSchema.parse(body).data ?? []) {
		if (!entry.url) {
			continue;
		}
		const declared = entry.mediaType ?? entry.mime_type ?? entry.content_type;
		const inline = DATA_URI_TYPE.exec(entry.url)?.[1];
		clips.push({
			url: entry.url,
			mediaType: declared ?? inline ?? "application/octet-stream",
		});
	}
	return clips;
}

/** Read the most useful error out of a non-2xx Core reply. */
function failureReason(body: unknown, fallback: string): string {
	const error = audioFailureSchema.parse(body).error;
	if (typeof error === "string" && error.trim()) {
		return error;
	}
	return error === undefined || error === null
		? fallback
		: JSON.stringify(error);
}

/** Poll a cloud audio job once via Core's `/api/audio/jobs/:id`. */
export async function pollAudioJob(
	target: ApiTarget,
	id: string
): Promise<RpcJsonResponse> {
	const resp = await authenticatedFetch(
		target,
		`/api/audio/jobs/${encodeURIComponent(id)}`,
		{ method: "GET" }
	);
	if (!resp.ok) {
		let body: unknown = null;
		try {
			body = await resp.json();
		} catch {
			// Non-JSON error body — keep the status-based message.
		}
		throw new Error(
			failureReason(body, `audio job poll failed: ${resp.status}`)
		);
	}
	return rpcJsonResponseSchema.parse(await resp.json());
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Generate music or a sound effect through Core's `/api/audio/generate`,
 * polling the cloud job until it finishes. Resolves to at least one file;
 * throws on a refused request, a failed job, a timeout or an empty result.
 */
export async function generateAudio(
	target: ApiTarget,
	request: GenerateAudioRequest
): Promise<GeneratedAudio[]> {
	const body: AudioGenerationWireRequest = {
		kind: request.kind,
		model: request.model,
		prompt: request.prompt,
		provider: request.provider,
	};
	if (request.durationS !== undefined) {
		body.duration_s = request.durationS;
	}
	if (request.providerInput !== undefined) {
		body.provider_input = request.providerInput;
	}
	if (request.requestId !== undefined) {
		body.request_id = request.requestId;
	}

	const resp = await authenticatedFetch(target, "/api/audio/generate", {
		method: "POST",
		headers:
			request.appId && request.appPermission
				? {
						"x-ryu-app-id": request.appId,
						"x-ryu-app-permission": request.appPermission,
					}
				: undefined,
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		let errorBody: unknown = null;
		try {
			errorBody = await resp.json();
		} catch {
			// Non-JSON error body — keep the status-based message.
		}
		throw new Error(
			failureReason(errorBody, `audio generation failed: ${resp.status}`)
		);
	}

	let jobBody = rpcJsonResponseSchema.parse(await resp.json());
	let job = audioJobSchema.parse(jobBody);
	const interval = request.pollIntervalMs ?? 3000;
	const deadline = Date.now() + (request.timeoutMs ?? 600_000);
	while (
		!(
			TERMINAL_SUCCESSES.has(job.status ?? "") ||
			TERMINAL_FAILURES.has(job.status ?? "")
		)
	) {
		if (job.id === undefined) {
			throw new Error("audio generation returned no job id to poll");
		}
		if (Date.now() >= deadline) {
			throw new Error("audio generation timed out");
		}
		await sleep(interval);
		jobBody = await pollAudioJob(target, job.id);
		job = { ...audioJobSchema.parse(jobBody), id: job.id };
	}
	if (TERMINAL_FAILURES.has(job.status ?? "")) {
		throw new Error(failureReason(jobBody, "audio generation failed"));
	}
	const clips = audioClipsFromBody(jobBody);
	if (clips.length === 0) {
		throw new Error("audio generation finished without an audio file");
	}
	return clips;
}
