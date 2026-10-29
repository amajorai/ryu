// The **live-activity vocabulary** — the Dynamic-Island half of Ryu's desktop
// shell. A live activity is a small, always-live card a surface renders for
// something in progress: an agent run, a download, a pending approval, a
// recording. It mirrors the mobile `AgentActivity` status lifecycle
// (`apps/native/lib/agent-activity.ts`) so the same mental model spans devices:
// an activity starts when the thing starts, updates as it progresses, and ends
// with a terminal "done" / "error" state.
//
// Two halves live here, mirroring `views.ts`:
//
// 1. The **runtime shape** — {@link LiveActivity}, the object built-in adapters
//    publish into the desktop store and surfaces render. Pure types + tiny
//    helpers, shared by every per-surface renderer.
// 2. The **declarative contribution** — {@link LiveActivityContribution}, the
//    opaque `spec` of a manifest `contributes.live_activities` entry. Like a
//    `sidebar_sections` entry it carries a {@link ViewSource} the shell polls
//    and a field-map; unlike a section it maps ROWS to live-activity cards
//    (status/progress/target) instead of nav rows. An app can expose a live
//    activity declaratively with zero sidecar code.
//
// The Rust envelope lives in `ryu-kernel-contracts` (`Contributes::live_activities` /
// `LiveActivityContribution`); the `spec` there is opaque, so a new activity
// capability needs no Core change. The desktop's generic renderer interprets it.

import { z } from "zod";

import { sourceItemsFromResponse, type ViewSource } from "./views.ts";

/** Lifecycle phase of a live activity, shared by every surface renderer. This is
 *  the exact status vocabulary the mobile `AgentActivity` uses, so an "agent
 *  working" activity reads identically on iOS Live Activity and the desktop
 *  shell. */
export const LIVE_ACTIVITY_STATUSES = [
	"running",
	"waiting",
	"review",
	"done",
	"error",
] as const;

export type LiveActivityStatus = (typeof LIVE_ACTIVITY_STATUSES)[number];

/** What activating a live activity does. `route` opens a client tab (the common
 *  case — "jump back into the chat"); `view` opens one of the owning plugin's
 *  declarative views. */
export type LiveActivityAction =
	| { kind: "route"; path: string }
	| { kind: "view"; pluginId: string; viewId: string };

/** One live activity card. Identity is the stable `id`; surfaces upsert by id so
 *  a running item updates in place rather than flickering. */
export interface LiveActivity {
	/** Accent colour hint (any CSS color). */
	accent?: string;
	/** What tapping the card does. */
	action?: LiveActivityAction;
	/** The owning app/plugin id — `"shell"` for a built-in adapter, otherwise the
	 *  plugin whose `contributes.live_activities` minted it. Used to group/collapse
	 *  the dock by source. */
	appId: string;
	/** Secondary line — the latest step / progress caption. */
	detail: string;
	/** Glyph id resolved by the host's Icon primitive. */
	icon?: string;
	/** Stable identity, e.g. `run:<id>`, `download:<id>`, or
	 *  `plugin:<pluginId>:<activityId>:<rowId>` for a contributed activity. */
	id: string;
	/** The activity kind (`"agent-run"`, `"download"`, or a contributed activity id). */
	kind: string;
	/** Optional 0..1 determinate progress; omit for indeterminate. */
	progress?: number;
	startedAt: number;
	status: LiveActivityStatus;
	/** Short headline. */
	title: string;
	updatedAt: number;
}

/** A pure predicate helpers use to decide which rows become live cards. */
export interface LiveActivityFilter {
	/** Keep only activities that are "live" — everything except a settled
	 *  `done`/`error`. Surfaces use this to drop terminal cards from the dock. */
	live: boolean;
}

/** True when the status is still in-flight (not a settled terminal state). */
export function isLiveStatus(status: LiveActivityStatus): boolean {
	return status === "running" || status === "waiting" || status === "review";
}

// ── The declarative contribution ─────────────────────────────────────────────

/**
 * Maps response-row keys to the live-activity fields they fill. Defaults mirror
 * {@link ViewSourceMap}: `id` → `"id"`, `title` → `"title"`, `icon` → `"icon"`;
 * the rest are omitted unless mapped. `status` names the row key whose VALUE is
 * a status string (either a {@link LiveActivityStatus} or one remapped by
 * {@link LiveActivitySourceMap.statusMap}); `progress` names a row key holding a
 * 0..1 (or 0..100) number. Both are what make a plain Core endpoint a live card.
 */
export interface LiveActivitySourceMap {
	accent?: string;
	detail?: string;
	icon?: string;
	id?: string;
	/** Row key holding a 0..1 (or 0..100) progress value. */
	progress?: string;
	/** Row key holding the activity's status string. */
	status?: string;
	/** Remap wire status values to {@link LiveActivityStatus} (e.g.
	 *  `{"in_progress": "running", "awaiting_input": "waiting"}`). Unmapped values
	 *  fall through unchanged when they are already a valid status, else `running`. */
	statusMap?: Record<string, LiveActivityStatus>;
	title?: string;
	/** Literal title used when the mapped `title` key is empty/absent. */
	titleFallback?: string;
}

/** A host-served audio source contributed by a desktop-only plugin. Audio is
 * intentionally metadata on a live-activity contribution rather than a second
 * agent-run stream: the shell owns one player and decides when it is active. */
export interface LiveActivityAudioSpec {
	/** Keep the source looping while at least one matching activity is running. */
	loop?: boolean;
	/** Browser/Tauri-resolvable URL for the audio asset. */
	src: string;
}

/**
 * The opaque `spec` of a manifest `contributes.live_activities` contribution (the
 * Rust `LiveActivityContribution`). Mirrors `SidebarSectionSpec`'s shape — a
 * {@link ViewSource} supplies the live rows, a field-map turns each into a card —
 * plus the two activity-specific keys `map.status`/`map.progress`.
 */
export interface LiveActivitySpec {
	/** Optional ambient audio for the shell's singleton live-activity player. */
	audio?: LiveActivityAudioSpec;
	/** Optional field-map from activity fields to response-row keys. */
	map?: LiveActivitySourceMap;
	/** Live rows for the activity (same primitive a `list-detail` view uses). */
	source?: ViewSource;
	/** Route template opened when the card is activated, filled with the clicked
	 *  row using the `{{item.<key>}}` vocabulary (e.g. `/chat?conversationId={{item.id}}`). */
	target?: string;
}

/** The wire envelope Core forwards (mirrors Rust `LiveActivityContribution`),
 *  tagged with the owning `plugin` id server-side. */
export interface LiveActivityContribution {
	/** Accent colour hint (any CSS color). */
	accent?: string;
	/** Core-stamped declarative HTTP authority. */
	http_policy?: import("./views.ts").ContributionHttpPolicy;
	icon?: string;
	id: string;
	/** Optional placement hint among the dock's activities (lower = first). */
	order?: number;
	/** Owning plugin id, added by Core's contributions endpoint. */
	plugin?: string;
	spec?: LiveActivitySpec;
	title: string;
}

// Source responses cross the same JSON boundary as the HTTP endpoint. Invalid
// individual field values stay absent so an optional field cannot discard a card.
const liveActivityRowSchema = z.record(
	z.string(),
	z.json().optional().catch(undefined)
);
export type LiveActivityRow = z.infer<typeof liveActivityRowSchema>;
const rowTextSchema = z.union([
	z.union([z.string(), z.number(), z.boolean()]).transform(String),
	z
		.union([z.array(z.json()), z.record(z.string(), z.json())])
		.transform((value) => JSON.stringify(value)),
]);
const liveActivityStatusSchema = z.enum(LIVE_ACTIVITY_STATUSES);

/** A source-fetched card: the mapped {@link LiveActivity} plus the RAW response
 *  row (the `{{item.<key>}}` templating base for `target`). */
export interface SourceLiveActivity {
	activity: LiveActivity;
	raw: LiveActivityRow;
}

function rawString(row: LiveActivityRow, key?: string): string | undefined {
	if (!key) {
		return undefined;
	}
	const value = row[key];
	if (value === null || value === undefined) {
		return undefined;
	}
	const parsed = rowTextSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function rawNumber(row: LiveActivityRow, key?: string): number | undefined {
	if (!key) {
		return undefined;
	}
	const value = row[key];
	const parsed = z.number().finite().safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** Resolve a wire status value to a {@link LiveActivityStatus}, honouring the
 *  contribution's `statusMap` first, then the literal status string, then a
 *  fallback of `running` (a row the map cannot classify is still an activity —
 *  the status vocabulary is the surface's, not the backend's). */
export function statusFromRow(
	row: LiveActivityRow,
	map: LiveActivitySourceMap | undefined
): LiveActivityStatus {
	const raw = rawString(row, map?.status);
	if (!raw) {
		return "running";
	}
	const mapped = map?.statusMap?.[raw];
	if (mapped) {
		return mapped;
	}
	const parsed = liveActivityStatusSchema.safeParse(raw);
	return parsed.success ? parsed.data : "running";
}

function progressFromRow(
	row: LiveActivityRow,
	map: LiveActivitySourceMap | undefined
): number | undefined {
	const value = rawNumber(row, map?.progress);
	if (value === undefined) {
		return undefined;
	}
	// Tolerate 0..100 percents as well as 0..1 fractions.
	const normalized = value > 1 ? value / 100 : value;
	if (normalized < 0) {
		return 0;
	}
	if (normalized > 1) {
		return 1;
	}
	return normalized;
}

/**
 * Map a contribution's source-fetch response to renderable {@link SourceLiveActivity}s.
 * Reuses {@link sourceItemsFromResponse} for the shared filtering/limiting/id-title
 * logic, then adds the activity-only fields (status/progress/accent/target base).
 * Forgiving in the same way: a row without a usable id/title is skipped and a
 * non-array payload yields `[]`, so a backend the shell cannot parse degrades to
 * an empty dock rather than a crash.
 */
export function liveActivitiesFromResponse(
	contribution: LiveActivityContribution,
	payload: Parameters<typeof sourceItemsFromResponse>[1],
	now: number = Date.now()
): SourceLiveActivity[] {
	const spec = contribution.spec;
	const source = spec?.source;
	if (!source) {
		return [];
	}
	const map = spec.map ?? {};
	return sourceItemsFromResponse(source, payload).map(
		({ item, raw: wireRow }) => {
			const raw = liveActivityRowSchema.parse(wireRow);
			const status = statusFromRow(raw, map);
			const activity: LiveActivity = {
				id: `plugin:${contribution.plugin ?? "unknown"}:${contribution.id}:${item.id}`,
				appId: contribution.plugin ?? "unknown",
				kind: contribution.id,
				title: item.title,
				detail: item.subtitle ?? item.detail ?? "",
				status,
				progress: progressFromRow(raw, map),
				icon: item.icon ?? contribution.icon,
				accent: rawString(raw, map.accent) ?? contribution.accent,
				startedAt: now,
				updatedAt: now,
			};
			return { activity, raw };
		}
	);
}

/** Render a contribution's `target` route template against the raw row. */
export function renderLiveActivityTarget(
	contribution: LiveActivityContribution,
	row: LiveActivityRow
): string | undefined {
	const target = contribution.spec?.target;
	if (!target) {
		return undefined;
	}
	// Inlined renderTemplate from views.ts (token `{{item.<key>}}`, URI-encoded).
	return target.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, token: string) => {
		const key = token.startsWith("item.") ? token.slice("item.".length) : token;
		const text = rawString(row, key) ?? "";
		return encodeURIComponent(text);
	});
}

/** A live activity's activation target, resolved to an action. */
export function actionForLiveActivity(
	contribution: LiveActivityContribution,
	row: LiveActivityRow
): LiveActivity["action"] {
	const path = renderLiveActivityTarget(contribution, row);
	if (path) {
		return { kind: "route", path };
	}
	return undefined;
}

// ── Validation ────────────────────────────────────────

/** Result of {@link validateLiveActivity}: `ok` plus flat human-readable errors. */
export interface LiveActivityValidation {
	errors: string[];
	ok: boolean;
}

const liveActivityContributionEnvelopeSchema = z.object({
	id: z.unknown().optional(),
	title: z.unknown().optional(),
});
const contributionLabelSchema = z.string().min(1);
/** Validate the required contribution labels while tolerating optional future fields. */
const liveActivityValidationSchema = z
	.unknown()
	.transform((value): LiveActivityValidation => {
		const parsed = liveActivityContributionEnvelopeSchema.safeParse(value);
		if (!parsed.success) {
			return { ok: false, errors: ["live activity must be an object"] };
		}
		const errors: string[] = [];
		if (!contributionLabelSchema.safeParse(parsed.data.id).success) {
			errors.push('live activity: "id" must be a non-empty string');
		}
		if (!contributionLabelSchema.safeParse(parsed.data.title).success) {
			errors.push('live activity: "title" must be a non-empty string');
		}
		return { ok: errors.length === 0, errors };
	});
export const validateLiveActivity = liveActivityValidationSchema.parse;

/** The reference example: an "agent working" card sourced from `/api/runs`. */
export const helloLiveActivity: LiveActivityContribution = {
	id: "hello",
	title: "Hello",
	icon: "activity-03",
	spec: {
		source: {
			http: { method: "GET", path: "/api/runs" },
			items: "runs",
			filter: [{ key: "run_status", equals: "running" }],
			map: {
				id: "id",
				title: "title",
				titleFallback: "Untitled run",
				detail: "folder_path",
			},
			refreshMs: 5000,
			limit: 5,
		},
		map: {
			status: "run_status",
			statusMap: {
				running: "running",
				completed: "done",
				failed: "error",
			},
		},
		target: "/chat?conversationId={{item.id}}",
	},
};

/** The example wrapped as a {@link SourceLiveActivity} list from a canned payload,
 *  so a harness can render it without a live Core. */
export function helloLiveActivityRows(): SourceLiveActivity[] {
	return liveActivitiesFromResponse(
		helloLiveActivity,
		{
			runs: [
				{
					id: "run-1",
					title: "Ship the docs",
					run_status: "running",
					folder_path: "/work/docs",
				},
				{
					id: "run-2",
					title: "Refactor sidecar",
					run_status: "completed",
					folder_path: "/work/ryu",
				},
			],
		},
		1_700_000_000_000
	);
}
