// apps/desktop/src/lib/api/shadow-types.ts

import type { ShadowMetadata } from "./shadow-schemas.ts";

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
