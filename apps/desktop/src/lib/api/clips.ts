// apps/desktop/src/lib/api/clips.ts
//
// Typed client for Core's Ryu Clips endpoints (`/api/clips*`). A Clip is an
// agent-native Loom/Jam recording: screen video (+optional audio), an
// agent-readable context manifest, a whisper transcript, and timestamped
// browser diagnostics. Core proxies these to the Shadow capture sidecar; the
// desktop never talks to Shadow directly. Wire shapes are already camelCase
// (Shadow authors the JSON with `serde(rename_all = "camelCase")`), so the Wire
// type equals the domain type here - no snake/camel mapping needed.
//
// Placement: this is a Core data-path client (it decides *what runs* - the local
// capture engine), reached through the same node target as every other module.

import { type ApiTarget, apiUrl, makeHeaders, request } from "./client.ts";

/** A browser tab tagged onto a clip's diagnostics track (present only when the
 * extension has attached one). */
export interface ClipTab {
	title?: string | null;
	url: string;
}

/** Which inputs a clip captured, as recorded in its manifest. */
export interface ClipCapture {
	mic: boolean;
	screen: boolean;
	systemAudio: boolean;
	tab?: ClipTab | null;
}

/** A diagnostic/console/network moment worth surfacing a frame for. */
export interface RecommendedMoment {
	/** Milliseconds since `t0EpochMs`. */
	atMs: number;
	reason: string;
}

/** The full agent-context manifest for one clip. */
export interface ClipContext {
	capture: ClipCapture;
	/** ISO-8601 timestamp. */
	createdAt: string;
	diagnosticsPath: string;
	durationMs: number;
	/** Core-rewritten frames endpoint (`/api/clips/:id/frame`). */
	framesEndpoint: string;
	id: string;
	recommendedMoments: RecommendedMoment[];
	/** Set by the ingest keyframe extractor when a capped detail mode had to
	 * subsample a long video, so the composer/agent knows coverage is partial.
	 * `attachContext` ignores it; it is surfaced for diagnostics only. */
	scanWarning?: string;
	t0EpochMs: number;
	title: string;
	transcriptPath: string;
	video: string;
}

/** A clip as it appears in the picker list. */
export interface ClipSummary {
	/** ISO-8601 timestamp. */
	createdAt: string;
	durationMs: number;
	id: string;
	title: string;
}

/** The audio toggle set the recording UI drives alongside the video-source
 * picker. Video (which screen/display/window) is chosen separately via
 * {@link ClipTarget}; these two are the independent audio inputs. */
export interface ClipCaptureSources {
	mic: boolean;
	systemAudio: boolean;
}

/** Which video surface a clip records. `screen` is the primary display in full
 * (the zero-config default); `display` targets a specific monitor by id and
 * `window` a specific window by id (both enumerated by {@link getSources}). */
export interface ClipTarget {
	displayId?: number;
	kind: "screen" | "display" | "window";
	windowId?: number;
}

/** A connected display, as reported by {@link getSources}. */
export interface ClipDisplay {
	id: number;
	label: string;
	primary: boolean;
}

/** An open window that can be captured, as reported by {@link getSources}. */
export interface ClipWindow {
	id: number;
	title: string;
}

/** The pickable capture surfaces on this node. */
export interface ClipSources {
	displays: ClipDisplay[];
	windows: ClipWindow[];
}

/** The payload Core forwards to Shadow's `clip::start`. */
export interface ClipStartOpts {
	displayId?: number;
	mic: boolean;
	screen: boolean;
	systemAudio: boolean;
	tab?: ClipTab;
	/** The chosen video surface. Defaults to `{ kind: "screen" }` (primary). */
	target?: ClipTarget;
	title?: string;
}

/**
 * Core degrades to `{ available: false, reason }` when the Shadow capture
 * sidecar is unreachable. Detect that shape and raise so callers surface a real
 * error instead of treating the placeholder as a clip.
 */
function assertAvailable(json: unknown): void {
	if (
		json &&
		typeof json === "object" &&
		(json as { available?: unknown }).available === false
	) {
		const reason = (json as { reason?: unknown }).reason;
		throw new Error(
			typeof reason === "string" ? reason : "Clip recording is unavailable"
		);
	}
}

/** Begin a recording. Returns the initial context (durationMs 0). */
export async function startClip(
	target: ApiTarget,
	opts: ClipStartOpts
): Promise<ClipContext> {
	const json = await request<ClipContext & { available?: boolean }>(
		target,
		"/api/clips/start",
		{ method: "POST", body: opts }
	);
	assertAvailable(json);
	return json;
}

/** Stop a recording and return its finalized context (video + transcript). */
export async function stopClip(
	target: ApiTarget,
	id: string
): Promise<ClipContext> {
	const json = await request<ClipContext & { available?: boolean }>(
		target,
		`/api/clips/${id}/stop`,
		{ method: "POST" }
	);
	assertAvailable(json);
	return json;
}

/** Pause an in-progress recording. The backend excludes the paused span from the
 * clip's duration, so on resume the elapsed tracks the backend, not wall clock.
 * Returns the clip's context at the pause point (its `durationMs` is authoritative). */
export async function pauseClip(
	target: ApiTarget,
	id: string
): Promise<ClipContext> {
	const json = await request<ClipContext & { available?: boolean }>(
		target,
		`/api/clips/${id}/pause`,
		{ method: "POST" }
	);
	assertAvailable(json);
	return json;
}

/** Resume a paused recording. Returns the refreshed context; its `durationMs`
 * excludes the paused span and is the source of truth for the elapsed timer. */
export async function resumeClip(
	target: ApiTarget,
	id: string
): Promise<ClipContext> {
	const json = await request<ClipContext & { available?: boolean }>(
		target,
		`/api/clips/${id}/resume`,
		{ method: "POST" }
	);
	assertAvailable(json);
	return json;
}

/** Enumerate the displays + windows this node can record, for the source picker. */
export async function getSources(target: ApiTarget): Promise<ClipSources> {
	const json = await request<ClipSources & { available?: boolean }>(
		target,
		"/api/clips/sources"
	);
	// A down sidecar yields `{ available: false }` with no surfaces - treat as empty.
	return { displays: json.displays ?? [], windows: json.windows ?? [] };
}

/** List clips on this node, newest first. */
export async function listClips(target: ApiTarget): Promise<ClipSummary[]> {
	const json = await request<{ available?: boolean; clips?: ClipSummary[] }>(
		target,
		"/api/clips"
	);
	// A down sidecar yields `{ available: false }` with no clips - treat as empty.
	return json.clips ?? [];
}

/** Fetch the agent-context manifest for one clip. */
export async function getClipContext(
	target: ApiTarget,
	id: string
): Promise<ClipContext> {
	const json = await request<ClipContext & { available?: boolean }>(
		target,
		`/api/clips/${id}/context`
	);
	assertAvailable(json);
	return json;
}

/**
 * How much visual detail the ingest keyframe extractor should recover:
 * - `transcript`: no frames, transcript-only bundle.
 * - `efficient`: ~50 evenly-sampled frames, no scene detection.
 * - `balanced`: scene-detected frames, capped (default 100).
 * - `tokenBurner`: uncapped scene-detected frames.
 * The default is `balanced`; the mode is per-request (nothing hardcoded).
 */
export type ClipDetailMode =
	| "transcript"
	| "efficient"
	| "balanced"
	| "tokenBurner";

/**
 * Ingest an external video into an agent-context clip bundle. `source` is either
 * a URL (downloaded by Core via yt-dlp) or an absolute local file path (passed
 * through), NOT a multipart upload - Core resolves it server-side. The returned
 * {@link ClipContext} is indistinguishable from a recorded clip's, so it flows
 * through the SAME composer attach funnel (pickMoments -> fetchClipFrameDataUrl).
 * Ingest is slow (download + transcode + keyframe extraction + transcript), so
 * callers should surface progress while this resolves.
 */
export async function ingestClip(
	target: ApiTarget,
	opts: {
		detail?: ClipDetailMode;
		end?: number;
		source: string;
		start?: number;
	}
): Promise<ClipContext> {
	const json = await request<ClipContext & { available?: boolean }>(
		target,
		"/api/clips/ingest",
		{ method: "POST", body: opts }
	);
	assertAvailable(json);
	return json;
}

/** Build the raw URL for a single extracted frame (used for `<img>` src). */
export function clipFrameUrl(
	target: ApiTarget,
	id: string,
	atMs: number
): string {
	return apiUrl(target, `/api/clips/${id}/frame?atMs=${atMs}`);
}

/**
 * Fetch one clip frame and return it as a `data:` URL so it can ride the
 * existing image-attachment path (which serializes attachments as data URLs).
 * Uses a raw fetch with only the Authorization header - the binary route sets
 * its own `image/jpeg` content type, so the JSON `request()` helper is wrong here
 * (voice.ts multipart pattern).
 */
export async function fetchClipFrameDataUrl(
	target: ApiTarget,
	id: string,
	atMs: number
): Promise<string> {
	const headers: Record<string, string> = {};
	const auth = makeHeaders(target.token).Authorization;
	if (auth) {
		headers.Authorization = auth;
	}
	const resp = await fetch(clipFrameUrl(target, id, atMs), { headers });
	if (!resp.ok) {
		throw new Error(`clip frame failed: ${resp.status}`);
	}
	const blob = await resp.blob();
	return await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("Failed to read clip frame"));
		reader.onload = () => resolve(reader.result as string);
		reader.readAsDataURL(blob);
	});
}

/** One even-subsampled keyframe in a recent-activity bundle. `dataUrl` is a
 * fully-inlined `data:image/jpeg;base64,...` string - Shadow reads each JPEG off
 * disk and base64s it into the bundle, so no per-frame fetch is needed. */
export interface RecentActivityFrame {
	/** Milliseconds from the start of the recent-activity window. */
	atMs: number;
	dataUrl: string;
}

/** Ephemeral ambient-context bundle from Shadow's timeline keyframes. Nothing is
 * persisted; it is attached to the next turn and then forgotten. Frame shape is
 * `{ atMs, dataUrl }` (fixed by contract), matching the clip attach funnel. */
export interface RecentActivityBundle {
	durationMs: number;
	frames: RecentActivityFrame[];
	summary: string;
	title: string;
	transcript?: string;
}

/**
 * Fetch the last `minutes` of ambient screen activity as an ephemeral frame
 * bundle. Proxies Core `GET /api/clips/recent-activity?minutes=`, which forwards
 * to Shadow's timeline keyframes (Core clamps `minutes` to 1..=15 server-side).
 * Raises via {@link assertAvailable} when Shadow is down, so the caller can
 * surface a real error instead of attaching an empty turn. The bundle is NOT a
 * clip: nothing is saved, and its frames already carry inline data URLs.
 */
export async function fetchRecentActivity(
	target: ApiTarget,
	minutes: number
): Promise<RecentActivityBundle> {
	const json = await request<RecentActivityBundle & { available?: boolean }>(
		target,
		`/api/clips/recent-activity?minutes=${minutes}`
	);
	assertAvailable(json);
	return { ...json, frames: json.frames ?? [] };
}
