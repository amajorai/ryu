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

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

/** A single generated clip, ready to drop into a `<video src>` (or `<img>`). */
export interface GeneratedVideo {
	/** Best-guess MIME (defaults to video/mp4 for base64 blobs). */
	mediaType: string;
	/** A `data:` or `http(s):` URL. */
	url: string;
}

/** Pull a `data:`/`http` URL out of one entry, trying the known field names. */
function entryToVideo(entry: unknown): GeneratedVideo | null {
	if (typeof entry === "string") {
		// A bare base64 string or URL.
		if (entry.startsWith("http") || entry.startsWith("data:")) {
			return { url: entry, mediaType: "video/mp4" };
		}
		return { url: `data:video/mp4;base64,${entry}`, mediaType: "video/mp4" };
	}
	if (!entry || typeof entry !== "object") {
		return null;
	}
	const obj = entry as Record<string, unknown>;
	if (typeof obj.url === "string") {
		return { url: obj.url, mediaType: "video/mp4" };
	}
	// sd-server may reuse the image field name for the encoded clip.
	const b64 =
		typeof obj.b64_json === "string"
			? obj.b64_json
			: typeof obj.video === "string"
				? obj.video
				: null;
	if (b64) {
		return { url: `data:video/mp4;base64,${b64}`, mediaType: "video/mp4" };
	}
	return null;
}

/** Extract renderable clips from a response/job body (data[]/videos[]/bare). */
function clipsFromBody(body: unknown): GeneratedVideo[] {
	const out: GeneratedVideo[] = [];
	const containers: unknown[] = [];
	if (Array.isArray(body)) {
		containers.push(...body);
	} else if (body && typeof body === "object") {
		const obj = body as Record<string, unknown>;
		if (Array.isArray(obj.data)) {
			containers.push(...obj.data);
		} else if (Array.isArray(obj.videos)) {
			containers.push(...obj.videos);
		} else {
			containers.push(body);
		}
	}
	for (const entry of containers) {
		const video = entryToVideo(entry);
		if (video) {
			out.push(video);
		}
	}
	return out;
}

/** Options for {@link generateVideo}. */
export interface GenerateVideoOptions {
	/** Cloud model id (required when `provider` is set). */
	model?: string;
	/** Poll interval while a cloud job runs, in ms. Default: 3000. */
	pollIntervalMs?: number;
	/** Cloud provider to route through the Gateway: `"replicate"` or `"fal"`.
	 * Omit (or use a local id) to render on the local sd-server engine. */
	provider?: string;
	/** Give up after this many ms for a cloud job. Default: 600000 (10 min). */
	timeoutMs?: number;
}

/** A submitted cloud video job. */
interface VideoJobEnvelope {
	error?: string;
	id?: string;
	status?: string;
	[key: string]: unknown;
}

/** Poll a cloud video job once via Core's `/api/video/jobs/:id`. */
export async function pollVideoJob(
	target: ApiTarget,
	id: string
): Promise<VideoJobEnvelope> {
	const resp = await fetch(apiUrl(target, `/api/video/jobs/${id}`), {
		method: "GET",
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw new Error(`video job poll failed: ${resp.status}`);
	}
	return (await resp.json()) as VideoJobEnvelope;
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
	const body: Record<string, unknown> = { prompt };
	if (options.provider) {
		body.provider = options.provider;
	}
	if (options.model) {
		body.model = options.model;
	}

	const resp = await fetch(apiUrl(target, "/api/video/generate"), {
		method: "POST",
		headers: makeHeaders(target.token),
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		let detail = `video generation failed: ${resp.status}`;
		try {
			const errorBody = (await resp.json()) as { error?: string };
			if (errorBody.error) {
				detail = errorBody.error;
			}
		} catch {
			// Non-JSON error body — keep the status-based message.
		}
		throw new Error(detail);
	}

	const first = (await resp.json()) as VideoJobEnvelope;

	// Local (synchronous) path: no job id → parse clips directly.
	if (!options.provider || typeof first.id !== "string") {
		return clipsFromBody(first);
	}

	// Cloud (job-based) path: poll until terminal.
	const interval = options.pollIntervalMs ?? 3000;
	const deadline = Date.now() + (options.timeoutMs ?? 600_000);
	let job: VideoJobEnvelope = first;
	while (job.status !== "succeeded" && job.status !== "failed") {
		if (Date.now() >= deadline) {
			throw new Error("video generation timed out");
		}
		await sleep(interval);
		job = await pollVideoJob(target, first.id);
	}
	if (job.status === "failed") {
		throw new Error(job.error ?? "video generation failed");
	}
	return clipsFromBody(job);
}
