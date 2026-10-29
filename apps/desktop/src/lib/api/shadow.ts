// apps/desktop/src/lib/api/shadow.ts
//
// Typed client for Shadow's context endpoints, reached through the LOCAL
// Core's authenticated `/api/shadow/*` proxy (`apps/core/src/server/
// shadow_proxy.rs`). Shadow is a standalone Rust sidecar that captures the
// active window, selection, and on-screen text via OCR; its own HTTP surface
// (:3030) is bearer-gated and rejects every browser (Origin-bearing) request
// outright, so the webview can no longer fetch it directly — Desktop presents
// its local node bearer to Core, which stamps Shadow's shared-secret bearer on
// the proxied hop. This module exposes
// typed `getCurrentContext()`, `getProactive()`, `getCaptureControl()`, and
// `setCaptureControl()` that the companion overlay and consent settings use.
// If Shadow (or the local Core) is not running, calls resolve to `null` so
// callers can degrade gracefully rather than crash.

import {
	fetchSpeechHistory,
	type SpeechHistoryInput,
} from "@ryuhq/core-client/shadow.ts";
import { z } from "zod";
import { DEFAULT_CORE_URL } from "@/lib/core-url.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";

/** Speech is always from this physical computer, independently of the selected node. */
export function getSpeechHistory(input: SpeechHistoryInput) {
	return fetchSpeechHistory(
		{
			url: DEFAULT_CORE_URL,
			token: useNodeStore.getState().nodes.find(isLocalNode)?.token ?? null,
		},
		input
	);
}

/** The context snapshot Shadow exposes at GET /context/current. */
export interface ShadowContext {
	/** Human-readable text exposed by the focused accessibility tree, if any. */
	accessibility_text?: string | null;
	/** Name of the focused application window. */
	active_app: string | null;
	/** True when capture is globally paused (pause/incognito mode). */
	paused?: boolean;
	/** OCR text visible on screen (may be long). */
	screen_text: string | null;
	/** Currently selected text, if any. */
	selected_text: string | null;
	/** Window title string. */
	window_title: string | null;
}

/** Capture control state returned by GET /capture/control. */
export interface CaptureControl {
	/**
	 * Per-app allowlist. Empty array means "allow all". Non-empty means
	 * capture is only active for apps matching an entry (case-insensitive).
	 */
	app_allowlist: string[];
	/**
	 * True when screen-frame (keyframe) capture is on. These are the JPEG
	 * screenshots the timeline scrubber shows; turning this off stops frame
	 * recording while leaving the rest of capture (OCR, clipboard, git, …) on.
	 */
	frames: boolean;
	/** Total days Shadow keeps captured Timeline/search history. */
	history_retention_days: number;
	/** True when capture is globally paused (pause/incognito mode active). */
	paused: boolean;
}

/** Request body for POST /capture/control. All fields optional. */
export interface CaptureControlUpdate {
	/**
	 * Replace the app allowlist. Empty array = allow all.
	 * Omit to leave the allowlist unchanged.
	 */
	app_allowlist?: string[];
	/**
	 * Toggle screen-frame (keyframe) capture. Omit to leave unchanged.
	 */
	frames?: boolean;
	/** Set the total captured-history retention window in days. */
	history_retention_days?: number;
	/** Set to true to suspend capture without killing the sidecar. */
	paused?: boolean;
}

export type ComputerUsePlanner = "native" | "jev" | "laya" | "local";

export interface ShadowComputerUseConfig {
	applied: boolean;
	jevApiKeyConfigured: boolean;
	jevModel: string;
	jevUrl: string;
	layaUrl: string;
	localModelId: string;
	localPluginId: string;
	maxSteps: number;
	planner: ComputerUsePlanner;
}

export interface ShadowComputerUseConfigUpdate
	extends Omit<ShadowComputerUseConfig, "applied" | "jevApiKeyConfigured"> {}

export interface ShadowComputerUseStep {
	operation: string;
	outcome: string;
	target: string | null;
}

export interface ShadowComputerUseResult {
	message: string;
	planner: ComputerUsePlanner;
	status: "completed" | "blocked" | "step_limit";
	steps: ShadowComputerUseStep[];
}

const computerUsePlannerSchema = z.enum(["native", "jev", "laya", "local"]);
const computerUseConfigSchema = z.object({
	applied: z.boolean(),
	planner: computerUsePlannerSchema,
	jevUrl: z.string(),
	jevModel: z.string(),
	layaUrl: z.string(),
	maxSteps: z.number(),
	jevApiKeyConfigured: z.boolean(),
	localPluginId: z.string().catch(""),
	localModelId: z.string().catch(""),
});

/** Validate a computer-use settings payload; `null` when it is malformed. */
function parseComputerUseConfig(
	value: unknown
): ShadowComputerUseConfig | null {
	const parsed = computerUseConfigSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

const shadowErrorSchema = z.object({
	error: z.union([
		z.string().refine((value) => Boolean(value.trim())),
		z
			.object({ message: z.string().refine((value) => Boolean(value.trim())) })
			.transform((value) => value.message),
	]),
});
const computerUseResultSchema = z.object({
	planner: computerUsePlannerSchema,
	status: z.enum(["completed", "blocked", "step_limit"]),
	message: z.string(),
	steps: z.array(z.json()),
});
const computerUseStepSchema = z.object({
	operation: z.string(),
	outcome: z.string(),
	target: z.json().optional(),
});

async function shadowError(
	response: Response,
	fallback: string
): Promise<Error> {
	try {
		const parsed = shadowErrorSchema.safeParse(await response.json());
		if (parsed.success) {
			return new Error(parsed.data.error);
		}
	} catch {
		// Use the HTTP status below when the sidecar returned a non-JSON error.
	}
	return new Error(`${fallback} (${response.status})`);
}

/** Strict settings reader: preserve failure rather than substituting defaults. */
export async function getShadowComputerUseConfigStrict(): Promise<ShadowComputerUseConfig> {
	const response = await shadowFetch("/computer-use/config", {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw await shadowError(
			response,
			"Could not load Shadow computer-use settings"
		);
	}
	const parsed = computerUseConfigSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("Core returned invalid Shadow computer-use settings");
	}
	return parsed.data;
}

export async function getShadowComputerUseConfig(): Promise<ShadowComputerUseConfig | null> {
	try {
		const response = await shadowFetch("/computer-use/config", {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) {
			return null;
		}
		return parseComputerUseConfig(await response.json());
	} catch {
		return null;
	}
}

export async function setShadowComputerUseConfig(
	update: ShadowComputerUseConfigUpdate
): Promise<ShadowComputerUseConfig> {
	const response = await shadowFetch("/computer-use/config", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(update),
	});
	if (!response.ok) {
		throw await shadowError(
			response,
			"Could not save Shadow computer-use settings"
		);
	}
	const parsed = computerUseConfigSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("Shadow returned invalid computer-use settings");
	}
	return parsed.data;
}

export async function runShadowComputerUse(
	goal: string
): Promise<ShadowComputerUseResult> {
	const response = await shadowFetch("/computer-use/run", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({ goal }),
	});
	if (!response.ok) {
		throw await shadowError(response, "Shadow computer use failed");
	}
	const parsed = computerUseResultSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("Shadow returned an invalid computer-use result");
	}
	const steps = parsed.data.steps.map((item) => {
		const step = computerUseStepSchema.safeParse(item);
		if (!step.success) {
			throw new Error("Shadow returned an invalid computer-use step");
		}
		const target = z.string().nullable().safeParse(step.data.target);
		if (!target.success) {
			throw new Error("Shadow returned an invalid computer-use target");
		}
		return { ...step.data, target: target.data };
	});
	return { ...parsed.data, steps };
}

/**
 * Disposition returned by Shadow's policy engine.
 * - `push_now` - surface immediately as a chip
 * - `inbox_only` - queue in inbox, do not push
 * - `drop` - discard; never shown
 */
export type SuggestionDisposition = "push_now" | "inbox_only" | "drop";

/** A proactive suggestion from Shadow at GET /proactive. */
export interface ProactiveSuggestion {
	/** Longer body text or null when Shadow has no suggestion. */
	body: string | null;
	/** Confidence score 0–1. */
	confidence: number;
	/** ISO-8601-ish unix timestamp (seconds since epoch). */
	created_at: number;
	/**
	 * Disposition assigned by Shadow's policy engine.
	 * Only `push_now` suggestions are shown as the overlay chip.
	 */
	disposition: SuggestionDisposition;
	/** Opaque stable identifier. */
	id: string;
	/** Arbitrary JSON metadata attached by Shadow. */
	metadata: ShadowMetadata;
	/** Category label (e.g. "action", "reminder"). */
	suggestion_type: string;
	/** Short headline for the suggestion. */
	title: string;
}

/** Feedback kind sent to Shadow's DeliveryManager via POST /api/feedback. */
export type FeedbackKind = "thumbs_up" | "thumbs_down" | "snooze" | "dismiss";

/** Request body for POST /api/feedback. */
export interface FeedbackRequest {
	/** The feedback action the user took. */
	kind: FeedbackKind;
	/** Must match `ProactiveSuggestion.suggestion_type`. */
	suggestion_type: string;
}

/**
 * INVARIANT: Shadow is local-only and device-bound.
 *
 * Shadow captures the screen, audio, input, and OCR of the *physical machine the
 * human is sitting at*. That context only has meaning relative to this device, so
 * every Shadow/Timeline/companion call in this module MUST stay pinned to the
 * local machine and must NEVER route through the per-tab node store
 * (`useActiveNode` / `ApiTarget`). Compute (chat, agents, Ghost) is swappable
 * across nodes; sensors are not — capturing a remote/headless node's screen would
 * surface another machine's activity as if it were yours.
 *
 * Do not parameterize this with a node URL. If you need Shadow on a different box,
 * run the desktop on that box.
 *
 * The base is the LOCAL Core's `/api/shadow` proxy (never the per-tab node):
 * `DEFAULT_CORE_URL` is the profile-aware local sidecar URL. Requests use the
 * local node bearer from `useNodeStore`, and Core stamps Shadow's own shared
 * secret on the upstream hop.
 */
const SHADOW_BASE = `${DEFAULT_CORE_URL}/api/shadow`;

/**
 * Shadow is pinned to this desktop's local Core, never the tab's active node.
 * Core requires the local node bearer even on loopback; keep it on this local
 * hop and never pass it to Jev or a model endpoint.
 */
function shadowFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	const token = useNodeStore.getState().nodes.find(isLocalNode)?.token;
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	return fetch(`${SHADOW_BASE}${path}`, { ...init, headers });
}

/** A single timeline event from GET /timeline. */
export interface TimelineEvent {
	/** Source/app label. */
	app_name: string | null;
	/** Device-local executable/application path used only for icon resolution. */
	app_path: string | null;
	/** Native bundle identifier when the platform exposes one. */
	bundle_id: string | null;
	/** Event subtype (e.g. "clipboard_change", "app_switch", "git_activity"). */
	event_type: string;
	/** Capture lane: 1 visual, 2 input, 3 window, 4 audio, 5 AX, 6 clipboard,
	 * 7 filesystem, 8 git, 9 terminal, 10 notification, 11 calendar. */
	track: number;
	/** Event timestamp in Unix microseconds. */
	ts: number;
	/** Associated URL when present. */
	url: string | null;
	/** Primary text (window title, clipboard snippet, file path, …). */
	window_title: string | null;
}

/** Dayflow-inspired derived work-journal snapshot from Shadow. */
export interface JournalSnapshot {
	apps: JournalStat[];
	cards: JournalCard[];
	categories: JournalStat[];
	end_ts: number;
	focus: FocusStats;
	standup: JournalStandup;
	start_ts: number;
}

export interface JournalCard {
	/** Optional for compatibility with older Shadow journal responses. */
	apps?: JournalApp[];
	category: string;
	/** Reconstruction-grade recap; upgraded by the LLM narration pass. */
	detailed_summary: string;
	distraction: boolean;
	/** Brief (<5 min) unrelated detours nested inside a focused card. */
	distractions: CardDistraction[];
	end_ts: number;
	event_count: number;
	id: string;
	primary_app: string;
	start_ts: number;
	summary: string;
	title: string;
}

/** Internal app identity used by the trusted desktop host before sanitization. */
export interface JournalApp {
	app_path: string | null;
	bundle_id: string | null;
	name: string;
}

export interface CardDistraction {
	end_ts: number;
	start_ts: number;
	summary: string;
	title: string;
}

export interface JournalStat {
	event_count: number;
	minutes: number;
	name: string;
}

export interface JournalStandup {
	blockers: string[];
	highlights: string[];
	tasks: string[];
}

/** Focus-vs-distraction analytics — the headline metric of the review surface. */
export interface FocusStats {
	communication_minutes: number;
	deep_work_minutes: number;
	distraction_minutes: number;
	focus_minutes: number;
	/** focus / (focus + distraction), 0..1. */
	focus_ratio: number;
	longest_focus_streak_minutes: number;
	total_minutes: number;
}

/** A week-long retrospective aggregated from daily snapshots (GET /journal/weekly). */
export interface WeeklyReview {
	apps: JournalStat[];
	categories: JournalStat[];
	days: DailyRollup[];
	end_ts: number;
	focus: FocusStats;
	highlights: string[];
	start_ts: number;
}

export interface DailyRollup {
	card_count: number;
	/** Label as "YYYY-MM-DD" from Shadow; format for display client-side. */
	day: string;
	distraction_minutes: number;
	focus_minutes: number;
	focus_ratio: number;
	start_ts: number;
	top_category: string;
}

/** A single full-text search hit from GET /search. */
export interface ShadowSearchResult {
	app_name: string | null;
	event_type: string;
	/** Why this matched (app/title/url/text/ocr/transcript). */
	match_reason: string | null;
	/** Text snippet for OCR/transcript results. */
	snippet: string | null;
	source_kind: string | null;
	track: number;
	ts: number;
	url: string | null;
	window_title: string | null;
}

const shadowMetadataSchema = z.record(z.string(), z.json());
type ShadowMetadata = z.infer<typeof shadowMetadataSchema>;
const shadowActivityEventSchema = z
	.object({ type: z.string() })
	.catchall(z.json());
export type ShadowActivityEvent = z.infer<typeof shadowActivityEventSchema>;
const timelineEventSchema = z
	.object({
		app_name: z.string().nullable(),
		app_path: z.string().nullable(),
		bundle_id: z.string().nullable(),
		event_type: z.string(),
		track: z.number(),
		ts: z.number(),
		url: z.string().nullable(),
		window_title: z.string().nullable(),
	})
	.passthrough();
const journalStatSchema = z
	.object({ event_count: z.number(), minutes: z.number(), name: z.string() })
	.passthrough();
const focusStatsSchema = z
	.object({
		communication_minutes: z.number(),
		deep_work_minutes: z.number(),
		distraction_minutes: z.number(),
		focus_minutes: z.number(),
		focus_ratio: z.number(),
		longest_focus_streak_minutes: z.number(),
		total_minutes: z.number(),
	})
	.passthrough();
const journalCardSchema = z
	.object({
		apps: z
			.array(
				z
					.object({
						app_path: z.string().nullable(),
						bundle_id: z.string().nullable(),
						name: z.string(),
					})
					.passthrough()
			)
			.optional(),
		category: z.string(),
		detailed_summary: z.string(),
		distraction: z.boolean(),
		distractions: z.array(
			z
				.object({
					end_ts: z.number(),
					start_ts: z.number(),
					summary: z.string(),
					title: z.string(),
				})
				.passthrough()
		),
		end_ts: z.number(),
		event_count: z.number(),
		id: z.string(),
		primary_app: z.string(),
		start_ts: z.number(),
		summary: z.string(),
		title: z.string(),
	})
	.passthrough();
const journalSnapshotSchema = z
	.object({
		apps: z.array(journalStatSchema),
		cards: z.array(journalCardSchema),
		categories: z.array(journalStatSchema),
		end_ts: z.number(),
		focus: focusStatsSchema,
		standup: z
			.object({
				blockers: z.array(z.string()),
				highlights: z.array(z.string()),
				tasks: z.array(z.string()),
			})
			.passthrough(),
		start_ts: z.number(),
	})
	.passthrough();
const weeklyReviewSchema = z
	.object({
		apps: z.array(journalStatSchema),
		categories: z.array(journalStatSchema),
		days: z.array(
			z
				.object({
					card_count: z.number(),
					day: z.string(),
					distraction_minutes: z.number(),
					focus_minutes: z.number(),
					focus_ratio: z.number(),
					start_ts: z.number(),
					top_category: z.string(),
				})
				.passthrough()
		),
		end_ts: z.number(),
		focus: focusStatsSchema,
		highlights: z.array(z.string()),
		start_ts: z.number(),
	})
	.passthrough();
const shadowSearchResultSchema = z
	.object({
		app_name: z.string().nullable(),
		event_type: z.string(),
		match_reason: z.string().nullable(),
		snippet: z.string().nullable(),
		source_kind: z.string().nullable(),
		track: z.number(),
		ts: z.number(),
		url: z.string().nullable(),
		window_title: z.string().nullable(),
	})
	.passthrough();
const shadowContextSchema = z
	.object({
		accessibility_text: z.string().nullable().optional(),
		active_app: z.string().nullable(),
		paused: z.boolean().optional(),
		screen_text: z.string().nullable(),
		selected_text: z.string().nullable(),
		window_title: z.string().nullable(),
	})
	.passthrough();
const proactiveSuggestionSchema = z
	.object({
		body: z.string().nullable(),
		confidence: z.number(),
		created_at: z.number(),
		disposition: z.enum(["push_now", "inbox_only", "drop"]),
		id: z.string(),
		metadata: shadowMetadataSchema,
		suggestion_type: z.string(),
		title: z.string(),
	})
	.passthrough();
const captureControlSchema = z
	.object({
		app_allowlist: z.array(z.string()),
		frames: z.boolean(),
		history_retention_days: z.number(),
		paused: z.boolean(),
	})
	.passthrough();
interface JournalOptions {
	narrate?: boolean;
	signal?: AbortSignal;
}

/**
 * Fetch timeline events in the window [now - rangeMinutes, now]. Returns `null`
 * when Shadow is unreachable so callers degrade gracefully.
 */
export async function getTimeline(
	rangeMinutes: number,
	signal?: AbortSignal
): Promise<TimelineEvent[] | null> {
	const now = Date.now() * 1000; // ms → µs
	const start = now - rangeMinutes * 60 * 1_000_000;
	try {
		const resp = await shadowFetch(`/timeline?start=${start}&end=${now}`, {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return null;
		}
		const data = z
			.object({ entries: z.array(timelineEventSchema).nullish() })
			.parse(await resp.json());
		return data.entries ?? [];
	} catch {
		return null;
	}
}

/**
 * Fetch derived activity cards, category/app stats, and standup bullets for the
 * same live range as the raw timeline. Returns `null` when Shadow is unreachable.
 */
export async function getJournal(
	rangeMinutes: number,
	options?: JournalOptions
): Promise<JournalSnapshot | null> {
	const now = Date.now() * 1000;
	const start = now - rangeMinutes * 60 * 1_000_000;
	const narrate = options?.narrate ? "&narrate=true" : "";
	try {
		const resp = await shadowFetch(
			`/journal?start=${start}&end=${now}${narrate}`,
			{
				signal: options?.signal,
				headers: { Accept: "application/json" },
			}
		);
		if (!resp.ok) {
			return null;
		}
		const data = z
			.object({ journal: journalSnapshotSchema.nullish() })
			.parse(await resp.json());
		return data.journal ?? null;
	} catch {
		return null;
	}
}

/**
 * Fetch the weekly retrospective: the trailing `days` calendar days folded into
 * focus analytics, per-day rollups, and category/app allocation. Returns `null`
 * when Shadow is unreachable so the Review page can render an empty state.
 */
export async function getWeeklyReview(
	days = 7,
	signal?: AbortSignal
): Promise<WeeklyReview | null> {
	const now = Date.now() * 1000;
	try {
		const resp = await shadowFetch(`/journal/weekly?end=${now}&days=${days}`, {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return null;
		}
		const data = z
			.object({ review: weeklyReviewSchema.nullish() })
			.parse(await resp.json());
		return data.review ?? null;
	} catch {
		return null;
	}
}

/** A message in an activity-chat conversation (Shadow POST /agent). */
export interface ActivityChatMessage {
	content: string;
	role: "assistant" | "user";
}

/**
 * Stream a chat-over-your-activity turn from Shadow's `POST /agent` SSE endpoint.
 * Shadow runs an agent whose tools search the local timeline, OCR, and
 * transcripts, so answers are grounded in what you actually did. `onEvent`
 * receives each decoded SSE JSON payload; switch on `type`:
 * `text_delta{text}` (incremental), `final_answer{text}` (complete answer),
 * `tool_call{id,name,args}`, `tool_result{id,name,result,error}`,
 * `error{message}`. The stream ends by closing (no explicit done event), at
 * which point this resolves. Never throws for a missing Shadow; it calls
 * `onEvent` with an `error` event and returns instead.
 */
export async function streamActivityChat(
	message: string,
	history: ActivityChatMessage[],
	onEvent: (event: ShadowActivityEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	let resp: Response;
	try {
		resp = await shadowFetch("/agent", {
			method: "POST",
			signal,
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify({
				message,
				conversation_history: history.map((m) => ({
					role: m.role,
					content: m.content,
				})),
			}),
		});
	} catch {
		onEvent({ type: "error", message: "Shadow is not running." });
		return;
	}
	if (!(resp.ok && resp.body)) {
		onEvent({ type: "error", message: `Shadow returned ${resp.status}.` });
		return;
	}

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	// SSE frames are separated by a blank line; each `data:` line carries JSON.
	try {
		while (!signal?.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split("\n\n");
			buffer = frames.pop() ?? "";
			for (const frame of frames) {
				for (const line of frame.split("\n")) {
					if (signal?.aborted) {
						return;
					}
					const trimmed = line.trim();
					if (!trimmed.startsWith("data:")) {
						continue;
					}
					const payload = trimmed.slice(5).trim();
					if (!payload || payload === "[DONE]") {
						continue;
					}
					try {
						onEvent(shadowActivityEventSchema.parse(JSON.parse(payload)));
					} catch {
						// Non-JSON keepalive or partial; ignore.
					}
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/**
 * URL of the nearest recorded keyframe at `tsMicros` (Unix microseconds) for an
 * optional `display`. Drop this straight into an `<img src>`; Shadow returns a
 * JPEG when a keyframe exists near that moment and 404s otherwise, so the caller
 * should render a fallback on the image's `onError`. Shadow records JPEG
 * keyframes out of the box (pure-Rust, no ffmpeg), so frames normally exist;
 * requests 404 only when frame capture is toggled off, capture is paused, or
 * none was recorded near that moment yet.
 */
export async function getShadowFrame(
	tsMicros: number,
	display?: number,
	signal?: AbortSignal
): Promise<Blob | null> {
	const params = new URLSearchParams({ ts: String(Math.round(tsMicros)) });
	if (display !== undefined) {
		params.set("display", String(display));
	}
	try {
		const response = await shadowFetch(`/frame?${params.toString()}`, {
			signal,
			headers: { Accept: "image/*" },
		});
		return response.ok ? await response.blob() : null;
	} catch {
		return null;
	}
}

/**
 * Full-text search across captured context (app/window, clipboard, filesystem,
 * git, terminal, OCR, transcripts). Returns `null` when Shadow is unreachable.
 */
export async function searchShadow(
	query: string,
	limit = 30,
	signal?: AbortSignal
): Promise<ShadowSearchResult[] | null> {
	if (!query.trim()) {
		return [];
	}
	try {
		const resp = await shadowFetch(
			`/search?q=${encodeURIComponent(query)}&limit=${limit}`,
			{ signal, headers: { Accept: "application/json" } }
		);
		if (!resp.ok) {
			return null;
		}
		const data = z
			.object({ results: z.array(shadowSearchResultSchema).nullish() })
			.parse(await resp.json());
		return data.results ?? [];
	} catch {
		return null;
	}
}

/**
 * Fetch the current screen context from Shadow.
 *
 * Returns `null` when Shadow is not running or the request fails so callers
 * can render a graceful "context unavailable" state rather than throwing.
 */
export async function getCurrentContext(
	signal?: AbortSignal
): Promise<ShadowContext | null> {
	try {
		const resp = await shadowFetch("/context/current", {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return null;
		}
		return shadowContextSchema.parse(await resp.json());
	} catch {
		return null;
	}
}

/**
 * Fetch the top PushNow proactive suggestion from Shadow.
 *
 * Shadow returns `{ suggestions: ProactiveSuggestion[] }`. This helper picks
 * the first suggestion whose disposition is `push_now`, or `null` when none
 * exists, Shadow is not running, or the request fails.
 *
 * Callers must handle `null` gracefully (no chip shown).
 */
export async function getProactive(
	signal?: AbortSignal
): Promise<ProactiveSuggestion | null> {
	try {
		const resp = await shadowFetch("/proactive", {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return null;
		}
		const data = z
			.object({ suggestions: z.array(proactiveSuggestionSchema).nullish() })
			.parse(await resp.json());
		const list = data.suggestions ?? [];
		return list.find((s) => s.disposition === "push_now") ?? null;
	} catch {
		return null;
	}
}

/**
 * Fetch the full proactive inbox from Shadow: every non-`drop` suggestion (both
 * `push_now` and `inbox_only`), so the desktop Inbox page can list them for
 * review. Unlike {@link getProactive} (top push_now only), this returns the whole
 * set. Empty on failure or when Shadow is unreachable, so callers degrade quietly.
 */
export async function getProactiveInbox(
	signal?: AbortSignal
): Promise<ProactiveSuggestion[]> {
	try {
		const resp = await shadowFetch("/proactive", {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return [];
		}
		const data = z
			.object({ suggestions: z.array(proactiveSuggestionSchema).nullish() })
			.parse(await resp.json());
		return (data.suggestions ?? []).filter((s) => s.disposition !== "drop");
	} catch {
		return [];
	}
}

/**
 * Post feedback for a proactive suggestion to Shadow's DeliveryManager.
 *
 * DeliveryManager.record_feedback uses this to calibrate trust scores so the
 * overlay surfaces better suggestions over time. Returns `true` on success,
 * `false` when Shadow is unreachable.
 */
export async function postFeedback(
	req: FeedbackRequest,
	signal?: AbortSignal
): Promise<boolean> {
	try {
		const resp = await shadowFetch("/api/feedback", {
			method: "POST",
			signal,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(req),
		});
		return resp.ok;
	} catch {
		return false;
	}
}

/**
 * Fetch the current capture-control state (pause flag + app allowlist).
 *
 * Returns `null` when Shadow is not running or the request fails.
 */
export async function getCaptureControl(
	signal?: AbortSignal
): Promise<CaptureControl | null> {
	try {
		const resp = await shadowFetch("/capture/control", {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!resp.ok) {
			return null;
		}
		return captureControlSchema.parse(await resp.json());
	} catch {
		return null;
	}
}

/**
 * Push updated capture-control settings to Shadow.
 *
 * Only the fields present in `update` are changed; omitted fields are left
 * as-is. Returns the resulting state, or `null` when Shadow is unreachable.
 */
export async function setCaptureControl(
	update: CaptureControlUpdate,
	signal?: AbortSignal
): Promise<CaptureControl | null> {
	try {
		const resp = await shadowFetch("/capture/control", {
			method: "POST",
			signal,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(update),
		});
		if (!resp.ok) {
			return null;
		}
		return captureControlSchema.parse(await resp.json());
	} catch {
		return null;
	}
}
