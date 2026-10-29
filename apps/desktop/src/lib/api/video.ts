// apps/desktop/src/lib/api/video.ts
//
// Typed client for Core's video-generation data path (`POST /api/video/generate`).
// Core proxies the prompt to the stable-diffusion.cpp media sidecar's NATIVE
// `/sdcpp/v1/vid_gen` endpoint and passes the response through verbatim.
//
// IMPORTANT — the response shape is NOT a stable, OpenAI-standard contract the
// way image generation's `{ data: [{ b64_json }] }` is. sd-server's vid_gen is a
// custom endpoint and its exact JSON is unverified here (video models are large +
// GPU-preferred and are not installed by default, so this path cannot be
// exercised in this environment). This parser is therefore DEFENSIVE: it accepts
// every plausible shape and returns whatever renderable media it can find,
// rather than assuming one layout. Treat the rendering as best-effort until a
// real video model run confirms the shape.

import {
	type RpcJsonResponse,
	type RyuJsonValue,
	rpcJsonResponseSchema,
} from "@ryu/app-host/rpc";
import { type ApiTarget, authenticatedFetch } from "./client.ts";
import {
	videoClipsSchema,
	videoFailureSchema,
	videoJobFieldsSchema,
} from "./video-wire-contracts.ts";

/** A single generated clip, ready to drop into a `<video src>` (or `<img>`). */
export interface GeneratedVideo {
	/** Best-guess MIME (defaults to video/mp4 for base64 blobs). */
	mediaType: string;
	/** A `data:` or `http(s):` URL. */
	url: string;
}

/** Vendor responses are full JSON; only the documented renderable fields are projected. */
function clipsFromBody(body: RpcJsonResponse): GeneratedVideo[] {
	return videoClipsSchema.parse(body);
}
/** Options for {@link generateVideo}. */
export interface GenerateVideoOptions {
	/** Host attribution for app-level generation ACLs. */
	appId?: string;
	/** Human-facing app permission required for this host-direct call. */
	appPermission?: string;
	/** Requested clip length in seconds, for `$duration_s` references. */
	durationS?: number;
	/** An audio track (`data:audio/*`) for lip-sync or talking avatars. */
	inputAudio?: string;
	/** `[first, last?]` reference frames as `data:image/*` URIs. */
	inputImages?: string[];
	/** A source clip (`data:video/*`) for video-to-video or matting. */
	inputVideo?: string;
	/** Cloud model id (required when `provider` is set). */
	model?: string;
	/** Poll interval while a cloud job runs, in ms. Default: 3000. */
	pollIntervalMs?: number;
	/** Cloud provider to route through the Gateway: `"replicate"` or `"fal"`.
	 * Omit (or use a local id) to render on the local sd-server engine. */
	provider?: string;
	/** Model-specific fields Core merges into the cloud provider body. Core
	 *  refuses routing keys and any input it cannot map for the target. */
	providerInput?: Record<string, RyuJsonValue>;
	/** Correlates this generation with an app-owned Gateway audit request. */
	requestId?: string;
	/** Give up after this many ms for a cloud job. Default: 600000 (10 min). */
	timeoutMs?: number;
}

/** Poll a cloud video job once via Core's `/api/video/jobs/:id`. */
export async function pollVideoJob(
	target: ApiTarget,
	id: string
): Promise<RpcJsonResponse> {
	const resp = await authenticatedFetch(
		target,
		`/api/video/jobs/${encodeURIComponent(id)}`,
		{
			method: "GET",
		}
	);
	if (!resp.ok) {
		throw new Error(`video job poll failed: ${resp.status}`);
	}
	return rpcJsonResponseSchema.parse(await resp.json());
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Generate a video from a text prompt via Core's `/api/video/generate`.
 *
 * Local generation (no cloud `provider`) is synchronous and returns clips
 * directly. Cloud providers (Replicate/Fal) are job-based: this submits the job
 * and then polls until it completes, so the caller still just awaits clips.
 * Resolves to an empty array when no renderable media is found; throws on a
 * transport/engine error or a failed job.
 */
export async function generateVideo(
	target: ApiTarget,
	prompt: string,
	options: GenerateVideoOptions = {}
): Promise<GeneratedVideo[]> {
	const body: VideoGenerationWireRequest = {
		prompt,
		request_id: options.requestId,
	};
	if (options.provider) {
		body.provider = options.provider;
	}
	if (options.model) {
		body.model = options.model;
	}
	// Reference inputs pass through unchanged: Core maps each one for the
	// selected target or refuses the request, so nothing is dropped here.
	if (options.inputImages && options.inputImages.length > 0) {
		body.input_images = options.inputImages;
	}
	if (options.inputVideo !== undefined) {
		body.input_video = options.inputVideo;
	}
	if (options.inputAudio !== undefined) {
		body.input_audio = options.inputAudio;
	}
	if (options.durationS !== undefined) {
		body.duration_s = options.durationS;
	}
	if (options.providerInput !== undefined) {
		body.provider_input = options.providerInput;
	}

	const resp = await authenticatedFetch(target, "/api/video/generate", {
		method: "POST",
		headers:
			options.appId && options.appPermission
				? {
						"x-ryu-app-id": options.appId,
						"x-ryu-app-permission": options.appPermission,
					}
				: undefined,
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		let detail = `video generation failed: ${resp.status}`;
		try {
			const errorBody = videoFailureSchema.parse(await resp.json());
			if (errorBody.error) {
				detail = String(errorBody.error);
			}
		} catch {
			// Non-JSON error body — keep the status-based message.
		}
		throw new Error(detail);
	}

	const first = rpcJsonResponseSchema.parse(await resp.json());
	const firstJob = videoJobFieldsSchema.parse(first);

	// Local (synchronous) path: no job id → parse clips directly.
	if (!options.provider || firstJob.id === undefined) {
		return clipsFromBody(first);
	}

	// Cloud (job-based) path: poll until terminal.
	const interval = options.pollIntervalMs ?? 3000;
	const deadline = Date.now() + (options.timeoutMs ?? 600_000);
	let jobBody = first;
	let job = firstJob;
	while (
		![
			"succeeded",
			"completed",
			"failed",
			"canceled",
			"cancelled",
			"expired",
		].includes(job.status ?? "")
	) {
		if (Date.now() >= deadline) {
			throw new Error("video generation timed out");
		}
		await sleep(interval);
		jobBody = await pollVideoJob(target, firstJob.id);
		job = videoJobFieldsSchema.parse(jobBody);
	}
	if (
		["failed", "canceled", "cancelled", "expired"].includes(job.status ?? "")
	) {
		throw new Error(String(job.error ?? "video generation failed"));
	}
	return clipsFromBody(jobBody);
}

interface VideoGenerationWireRequest {
	duration_s?: number;
	input_audio?: string;
	input_images?: string[];
	input_video?: string;
	model?: string;
	prompt: string;
	provider?: string;
	provider_input?: Record<string, RyuJsonValue>;
	request_id?: string;
}
