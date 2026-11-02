// Part of the Island IPC type contract; `./ipc.ts` re-exports it, so import
// from there. Type-only: the sandboxed preload loads `./ipc.ts` at runtime.

import type { IslandIpcValue } from "./ipc.ts";

// ── Shadow: context, suggestions, capture control ────────────────────────────

/** Context snapshot from Shadow's `GET /context/current`. */
export interface ShadowContext {
	app_name: string | null;
	capture_active: boolean;
	ocr_text: string | null;
	ocr_timestamp_us: number | null;
	paused: boolean;
	selected_text: string | null;
	timestamp_us: number | null;
	window_title: string | null;
}

/** Result of a Shadow context probe. */
export type ShadowContextResult =
	| { available: true; context: ShadowContext }
	| { available: false; reason: string };

/** Disposition assigned by Shadow's policy engine. */
export type SuggestionDisposition = "push_now" | "inbox_only" | "drop";

/** A proactive suggestion from Shadow at `GET /proactive`. */
export interface ProactiveSuggestion {
	body: string | null;
	confidence: number;
	created_at: number;
	disposition: SuggestionDisposition;
	id: string;
	metadata: Record<string, IslandIpcValue>;
	suggestion_type: string;
	title: string;
}

/** Result of a proactive-suggestion probe. */
export type ShadowProactiveResult =
	| { available: true; suggestion: ProactiveSuggestion | null }
	| { available: false; reason: string };

/**
 * Result of a proactive-INBOX probe: every stored suggestion the policy engine
 * did not drop (`inbox_only` + `push_now`), newest first. The transient chip
 * only ever surfaces the top `push_now` one; this is how the user reviews the
 * rest that Shadow already persisted.
 */
export type ShadowProactiveInboxResult =
	| { available: true; suggestions: ProactiveSuggestion[] }
	| { available: false; reason: string };

/** Feedback kind sent to Shadow via `POST /api/feedback`. */
export type FeedbackKind = "thumbs_up" | "thumbs_down" | "snooze" | "dismiss";

/** Body for `POST /api/feedback`. */
export interface FeedbackRequest {
	kind: FeedbackKind;
	suggestion_type: string;
}

/** Result of posting feedback. */
export interface FeedbackResult {
	available: boolean;
	ok?: boolean;
	reason?: string;
}

/** Capture-control state from `GET /capture/control`. */
export interface CaptureControl {
	app_allowlist: string[];
	paused: boolean;
}

/** Body for `POST /capture/control`. All fields optional. */
export interface CaptureControlUpdate {
	app_allowlist?: string[];
	paused?: boolean;
}

/** Result of a capture-control read or write. */
export type CaptureControlResult =
	| { available: true; control: CaptureControl }
	| { available: false; reason: string };

// ── Suggestion engine (U3) ───────────────────────────────────────────────────

/** Where a surfaced suggestion came from. */
export type SuggestionSource =
	| "local_model"
	| "shadow_proactive"
	| "connect_event";

/** A suggestion surfaced to the renderer by the engine. */
export interface IslandSuggestion {
	/** Optional action hint: open chat or just dismiss. */
	action: "chat" | "dismiss";
	/** App the context belonged to when generated (for feedback + dedupe). */
	appName: string | null;
	/** Supporting detail. May be empty. */
	body: string;
	/** Model/Shadow confidence in [0, 1]. */
	confidence: number;
	/** Stable id (also used as the dedupe-aware identity for feedback). */
	id: string;
	/** Origin of the suggestion. */
	source: SuggestionSource;
	/** Source-specific category; `context` for screen suggestions. */
	suggestionType: string;
	/** Short headline. */
	title: string;
	/** Epoch milliseconds when emitted. */
	ts: number;
}

/** Lifecycle state of the engine, mirrored to the renderer. */
export interface SuggestionEngineStatus {
	/** Count of suggestions emitted this session. */
	emitted: number;
	/** Last context-poll outcome ("ok" | reason string) for diagnostics. */
	lastContextReason: string | null;
	/** True once `start()` has run and timers are active. */
	running: boolean;
}

/** Feedback the renderer sends back about a surfaced suggestion. */
export interface SuggestionFeedbackRequest {
	id: string;
	kind: FeedbackKind;
}

/** Result of routing feedback through to Shadow + the cooldown. */
export type SuggestionFeedbackResult =
	| { ok: true }
	| { ok: false; reason: string };

/** Renderer-facing suggestion API (`window.island.suggestions`). */
export interface IslandSuggestionsApi {
	/** Send accept/dismiss/snooze feedback for a surfaced suggestion. */
	feedback(req: SuggestionFeedbackRequest): Promise<SuggestionFeedbackResult>;
	/** Subscribe to a "cleared" event (engine stopped / consent revoked). */
	onCleared(listener: () => void): () => void;
	/** Subscribe to new suggestions. Returns an unsubscribe function. */
	onNew(listener: (suggestion: IslandSuggestion) => void): () => void;
	/** Start the engine (consent gate for U6 lives upstream of this). */
	start(): Promise<SuggestionEngineStatus>;
	/** Read the current engine status. */
	status(): Promise<SuggestionEngineStatus>;
	/** Stop the engine and clear timers + history. */
	stop(): Promise<SuggestionEngineStatus>;
}

// ── Meeting notes (auto-detection + recording) ───────────────────────────────
//
// Core owns the meeting brain (detection, capture orchestration, transcription,
// notes). The island is a thin surface: the main process subscribes to Core's
// `GET /api/meetings/stream` SSE and forwards events; on a `detected` event the
// renderer offers a "start notes?" chip that calls `meetings.start`. Audio
// capture is device-local (Shadow), never the island.

/** A meeting as the island needs it (a subset of Core's `Meeting`). */
export interface IslandMeeting {
	app?: string | null;
	id: string;
	status: string;
	title: string;
}

/** Live meeting events forwarded from Core's SSE stream (subset used here). */
export type IslandMeetingEvent =
	| { type: "detected"; app: string; title: string; detected_at: string }
	| { type: "started"; meeting: IslandMeeting }
	| { type: "segment"; segment: { meeting_id: string; text: string } }
	| { type: "status"; meeting_id: string; status: string }
	| { type: "finalized"; meeting: IslandMeeting };

/** Body for starting a meeting from the island. */
export interface IslandStartMeetingInput {
	app?: string;
	source?: "manual" | "auto";
	title?: string;
}

/** Result of a start/finalize action. Never rejects to the renderer. */
export type IslandMeetingResult =
	| { available: true; meeting: IslandMeeting }
	| { available: false; reason: string };

/** Meeting methods exposed to the renderer (`window.island.meetings`). */
export interface IslandMeetingsApi {
	/** Finalize a meeting (stop capture + generate notes). Never rejects. */
	finalize(id: string): Promise<IslandMeetingResult>;
	/** Subscribe to live meeting events. Returns an unsubscribe function. */
	onEvent(listener: (event: IslandMeetingEvent) => void): () => void;
	/** Start recording a meeting. Never rejects. */
	start(input?: IslandStartMeetingInput): Promise<IslandMeetingResult>;
}

// ── Quests (auto-detecting todo list) ────────────────────────────────────────
//
// Core owns the quest brain (it watches Shadow context and judges whether a task
// is done). The island is a thin surface: the main process subscribes to Core's
// `GET /api/quests/events` SSE and forwards events; on a `suggested` event the
// renderer offers a "looks done — mark it?" chip that confirms or rejects via
// `quests.accept` / `quests.dismiss`. The `suggested` event is consent-gated.

/** A quest as the island needs it (a subset of Core's `Quest`). */
export interface IslandQuest {
	id: string;
	status: string;
	title: string;
}

/** Live quest events forwarded from Core's SSE stream (subset used here). */
export type IslandQuestEvent =
	| {
			type: "suggested";
			quest: IslandQuest;
			confidence: number;
			reason: string;
	  }
	| { type: "completed"; quest: IslandQuest; auto: boolean }
	| { type: "updated"; quest: IslandQuest }
	| { type: "deleted"; id: string };

/** Result of an accept/dismiss action. Never rejects to the renderer. */
export type IslandQuestResult =
	| { available: true; quest: IslandQuest }
	| { available: false; reason: string };

/** Quest methods exposed to the renderer (`window.island.quests`). */
export interface IslandQuestsApi {
	/** Confirm a detected completion (mark the quest done). Never rejects. */
	accept(id: string): Promise<IslandQuestResult>;
	/** Reject the pending suggestion but keep the quest open. Never rejects. */
	dismiss(id: string): Promise<IslandQuestResult>;
	/** Subscribe to live quest events. Returns an unsubscribe function. */
	onEvent(listener: (event: IslandQuestEvent) => void): () => void;
}

// ── Consent + privacy (U6) ───────────────────────────────────────────────────

// Per-capability consent. `chat` defaults ON (the island is a chat surface);
// `contextRead` (screen/window capture via Shadow :3030) and `proactive` (the
// suggestion engine) are UNSET until the user answers the first-run consent
// card, so `null` means "ask". A HARD GATE in the main process blocks every
// request to Shadow while `contextRead` is not `true`, and the suggestion engine
// must consult `shouldRunEngine()` before starting.
export interface ConsentState {
	/** Chat with Core. Defaults to `true`. */
	chat: boolean;
	/** Screen/window context capture via Shadow. `null` = unanswered (ask). */
	contextRead: boolean | null;
	/** Proactive suggestion engine. `null` = unanswered (ask). */
	proactive: boolean | null;
}

/** A single capability the consent card can grant or decline. */
export type ConsentCapability = "chat" | "contextRead" | "proactive";

/** Patch for `consent:set`: any subset of capabilities. */
export interface ConsentPatch {
	chat?: boolean;
	contextRead?: boolean | null;
	proactive?: boolean | null;
}

/** Tunables the proactive engine reads. Persisted alongside service config. */
export interface EngineSettings {
	/** Minimum seconds between two pushed suggestions (cooldown). */
	cooldownSeconds: number;
	/** How often (seconds) the engine polls Shadow for context. */
	pollIntervalSeconds: number;
}

/**
 * The full settings surface the expanded island reads/writes: service endpoints
 * (Core/Shadow URLs + optional token) plus engine tunables. Mirrors the persisted
 * `IslandServiceConfig` on the main side without exposing file paths.
 */
export interface IslandSettings {
	coreBaseUrl: string;
	coreToken: string | null;
	engine: EngineSettings;
	shadowBaseUrl: string;
}

/** Patch for `settings:set`: any subset of the settings surface. */
export interface IslandSettingsPatch {
	coreBaseUrl?: string;
	coreToken?: string | null;
	engine?: Partial<EngineSettings>;
	shadowBaseUrl?: string;
}
