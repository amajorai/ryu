import { updateCheckResponseSchema } from "@ryuhq/core-client/updates.ts";
import { z } from "zod";
// apps/desktop/src/lib/api/update.ts
//
// Typed client for Core's unified update service (`/api/version`,
// `/api/update/check`). Core is the single source of truth for the update
// *verdict* and the shared *auto-update toggle* (stored in the cross-surface
// preferences KV, so the same setting governs every surface). The actual
// install on desktop is performed by tauri-plugin-updater — but whether to
// surface the toast, and whether to auto-install, is decided from Core's verdict
// + this setting, so all surfaces stay consistent.

import { getUpdatesCutoff } from "@/src/lib/updates-window.ts";
import { getReleaseChannel } from "../release-channel.ts";
import { type ApiTarget, request } from "./client.ts";
import { getPreference, setPreference } from "./preferences.ts";

/** Matches Core's `update::ComponentVersion`. */
export interface ComponentVersion {
	name: string;
	version: string;
}

/** Matches Core's `update::VersionInfo` (`GET /api/version`). */
export interface VersionInfo {
	components: ComponentVersion[];
	platform: string;
	ryu_version: string;
}

/** Matches Core's `update::ReleaseAsset`. */
export interface ReleaseAsset {
	kind: string;
	name: string;
	size: number;
	url: string;
}

/**
 * Matches Core's `update::UpdateCheck` (`GET /api/update/check`).
 *
 * The six updates-window fields are all OPTIONAL, and that is load-bearing: a NEW
 * desktop talking to an OLD Core receives none of them, every guard downstream
 * reads `undefined` as falsy, and the app behaves exactly as it does today. Never
 * make one of them required to "tighten" the type — that would turn a version skew
 * into a runtime surprise instead of the historical, unclamped path.
 */
export interface UpdateCheck {
	asset: ReleaseAsset | null;
	/**
	 * The release channel the verdict was computed on. Defaults to the channel the
	 * running build is on (derived from its own version), overridden by the user's
	 * channel picker. Comparisons are scoped WITHIN this channel — moving between
	 * channels is a channel switch, not an update.
	 */
	channel: string;
	current: string;
	/**
	 * True when a cutoff was sent but NO eligible release was resolved. `latest` is
	 * then a placeholder and asserts nothing — never tell the user it is "the newest
	 * build your window covers". Absent on an older Core.
	 */
	cutoff_unresolved?: boolean;
	/**
	 * True when the offered release is a security release handed over despite the
	 * cutoff. Absent on an older Core.
	 */
	cutoff_waived_for_security?: boolean;
	/**
	 * Set when Core's check itself failed (network/API error, GitHub rate
	 * limit). Core fails open — 200 with `update_available: false` and
	 * `latest` echoing `current` — so without reading this field a failed
	 * check is indistinguishable from a genuine "up to date".
	 */
	error?: string | null;
	html_url: string | null;
	latest: string;
	/**
	 * The newest release on the channel ignoring the cutoff. Absent on an older
	 * Core; treat as equal to `latest`.
	 */
	latest_unrestricted?: string;
	notes: string | null;
	/** RFC-3339 publish time of the release `latest` names. Absent on an older Core. */
	published_at?: string | null;
	/**
	 * True when the caller's updates window held `latest` back from
	 * `latest_unrestricted`. Distinct from `update_available: false`, which also
	 * means "the check failed" — see `updateCheckFailed`.
	 */
	restricted_by_cutoff?: boolean;
	/**
	 * The git tag of the release `latest` names. NOT derivable from `latest`:
	 * rolling channels tag `nightly` while their version lives in the release title.
	 * Anything addressing a specific release must use this. Absent on an older Core.
	 */
	tag?: string | null;
	update_available: boolean;
}

/** True when the verdict reports a FAILED check rather than a real "no update". */
export function updateCheckFailed(verdict: UpdateCheck): boolean {
	return (
		Boolean(verdict.error) ||
		// `cutoff_unresolved` means Core searched back through the releases page and
		// could not find any build the caller's window covers, so it echoed `latest`
		// = `current` as a PLACEHOLDER. Without this arm every caller reads that as
		// a clean "you're up to date" and presents the placeholder as a real
		// ceiling — the one claim Core explicitly forbids any surface from making.
		verdict.cutoff_unresolved === true ||
		!(verdict.update_available || verdict.latest)
	);
}

/** Read the installed Ryu version + per-component builds. */
export function getVersionInfo(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<VersionInfo> {
	return request<VersionInfo>(
		target,
		"/api/version",
		{ signal },
		versionInfoResponseSchema
	);
}

export interface CheckForUpdateOptions {
	/**
	 * Send the signed-in owner's lapsed lifetime updates cutoff with the check.
	 *
	 * OFF by default, and deliberately opt-in per call site: three of the callers
	 * here target a REMOTE node (the node selector, the download centre, Preflight)
	 * and one targets the NODE's Core/Gateway binaries (the Gateway dialog's
	 * Updates tab). A self-hosted or shared node has no lifetime owner, and
	 * clamping it would withhold Core/Gateway updates — including security fixes —
	 * from everyone on it because one desktop user's personal window lapsed.
	 *
	 * Only pass `true` for THIS app's own LOCAL node (`isLocalNode`).
	 */
	clamp?: boolean;
	signal?: AbortSignal;
}

/**
 * Ask Core whether an update is available. Fails soft: on any error returns a
 * "no update" verdict so a flaky check never blocks the UI.
 */
export async function checkForUpdate(
	target: ApiTarget,
	options?: CheckForUpdateOptions
): Promise<UpdateCheck> {
	// Ask Core about the channel the USER picked, not just the one this build
	// happens to be on — otherwise a user who switches to nightly keeps getting the
	// stable verdict and the picker looks broken. Core defaults to the running
	// build's own channel when the parameter is absent.
	const channel = getReleaseChannel();
	const params = new URLSearchParams({ channel });
	// Null unless the caller opted in AND this account's window has actually
	// lapsed, so free users, subscribers and in-window owners send the exact query
	// string they send today.
	const cutoff = options?.clamp === true ? getUpdatesCutoff() : null;
	if (cutoff) {
		params.set("updates_until", cutoff);
	}
	try {
		return await request<UpdateCheck>(
			target,
			`/api/update/check?${params.toString()}`,
			{ signal: options?.signal },
			updateCheckResponseSchema
		);
	} catch {
		// Deliberately leaves every updates-window field undefined. A transport
		// failure must never read as "your window lapsed" — that is the distinction
		// `restricted_by_cutoff` exists to preserve.
		return {
			current: "",
			latest: "",
			channel,
			update_available: false,
			notes: null,
			html_url: null,
			asset: null,
		};
	}
}

/** Matches Core's `update::apply::ApplyResult` (`POST /api/update/apply`). */
export interface ApplyUpdateResult {
	/** The new binary was swapped into place. */
	applied: boolean;
	/** Human-readable next step. */
	message: string;
	/** A further step is needed — run an installer, or restart to pick it up. */
	restart_required: boolean;
	/** Absolute path of the staged artifact on the node. */
	staged_path: string;
}

/**
 * Ask the NODE to download + install the release itself (`POST
 * /api/update/apply`).
 *
 * This is the right path for a node the desktop does not own — a cloud/remote
 * Core, where the desktop's native Tauri updater would replace the LOCAL app
 * bundle and leave the remote node on its old build. For a local node the
 * bundled updater is correct instead: Core, Gateway and the CLI ship inside the
 * desktop bundle and move as one.
 */
export function applyNodeUpdate(
	target: ApiTarget,
	asset: ReleaseAsset
): Promise<ApplyUpdateResult> {
	// `request` serializes the body itself — pass the asset, not a JSON string.
	return request<ApplyUpdateResult>(
		target,
		"/api/update/apply",
		{
			method: "POST",
			body: asset,
		},
		applyUpdateResultResponseSchema
	);
}

// --- Deferred install ("tonight" instead of "now") -------------------------

/** Matches Core's `update::schedule::PendingUpdate`. */
export interface PendingUpdate {
	asset: ReleaseAsset;
	/** UTC instant the node will install at. */
	scheduled_for: string;
	/** The zone the quiet hour was computed in — the NODE's, not the viewer's. */
	time_zone: string;
	/** The version the user was shown when they deferred. */
	version: string;
}

/**
 * Install this update at the node's next quiet hour instead of now.
 *
 * The asset is PINNED here rather than re-resolved when the window arrives, so
 * what installs at 03:00 is the version the user actually saw and agreed to.
 *
 * Scheduled ON THE NODE, in the NODE's zone. An update restarts the machine, so
 * the machine that restarts is the one whose night matters — a viewer in another
 * timezone deferring to "tonight" means the node's tonight, not theirs.
 */
export function scheduleNodeUpdate(
	target: ApiTarget,
	asset: ReleaseAsset,
	version: string
): Promise<PendingUpdate> {
	return request<PendingUpdate>(
		target,
		"/api/update/schedule",
		{
			method: "POST",
			body: { asset, version },
		},
		pendingUpdateResponseSchema
	);
}

/** The node's pending deferred update, if any, plus the node's own zone. */
export function getNodeUpdateSchedule(
	target: ApiTarget
): Promise<{ pending: PendingUpdate | null; timeZone: string }> {
	return request(
		target,
		"/api/update/schedule",
		{},
		getNodeUpdateScheduleResponseSchema
	);
}

/** Cancel a deferred update. Idempotent. */
export function cancelNodeUpdateSchedule(
	target: ApiTarget
): Promise<{ ok: boolean }> {
	return request(
		target,
		"/api/update/schedule",
		{ method: "DELETE" },
		cancelNodeUpdateScheduleResponseSchema
	);
}

// --- Auto-update toggle (shared cross-surface via Core preferences) ---------
// Key matches Core's `update::AUTO_UPDATE_PREF_KEY`. Stored as `{ "enabled": bool }`.

export const AUTO_UPDATE_PREF_KEY = "auto-updates";

/** Whether automatic updates are enabled. Defaults to `true` when unset. */
export async function getAutoUpdateEnabled(
	target: ApiTarget
): Promise<boolean> {
	const raw = await getPreference(target, AUTO_UPDATE_PREF_KEY);
	if (!raw) {
		return true;
	}
	try {
		const parsed = z
			.object({ enabled: z.boolean().optional().catch(undefined) })
			.parse(JSON.parse(raw));
		return parsed.enabled !== false;
	} catch {
		return true;
	}
}

/** Persist the auto-update toggle. Returns success. */
export function setAutoUpdateEnabled(
	target: ApiTarget,
	enabled: boolean
): Promise<boolean> {
	return setPreference(
		target,
		AUTO_UPDATE_PREF_KEY,
		JSON.stringify({ enabled })
	);
}

const versionInfoResponseSchema: z.ZodType<VersionInfo> =
	retainValidatedResponse(
		z
			.object({
				components: z.array(
					z.object({ name: z.string(), version: z.string() }).passthrough()
				),
				platform: z.string(),
				ryu_version: z.string(),
			})
			.passthrough()
	);
const applyUpdateResultResponseSchema: z.ZodType<ApplyUpdateResult> =
	retainValidatedResponse(
		z
			.object({
				applied: z.boolean(),
				message: z.string(),
				restart_required: z.boolean(),
				staged_path: z.string(),
			})
			.passthrough()
	);
const pendingUpdateResponseSchema: z.ZodType<PendingUpdate> =
	retainValidatedResponse(
		z
			.object({
				asset: z
					.object({
						kind: z.string(),
						name: z.string(),
						size: z.number(),
						url: z.string(),
					})
					.passthrough(),
				scheduled_for: z.string(),
				time_zone: z.string(),
				version: z.string(),
			})
			.passthrough()
	);
const getNodeUpdateScheduleResponseSchema: z.ZodType<{
	pending: PendingUpdate | null;
	timeZone: string;
}> = retainValidatedResponse(
	z
		.object({
			pending: z.union([
				z
					.object({
						asset: z
							.object({
								kind: z.string(),
								name: z.string(),
								size: z.number(),
								url: z.string(),
							})
							.passthrough(),
						scheduled_for: z.string(),
						time_zone: z.string(),
						version: z.string(),
					})
					.passthrough(),
				z.null(),
			]),
			timeZone: z.string(),
		})
		.passthrough()
);
const cancelNodeUpdateScheduleResponseSchema: z.ZodType<{ ok: boolean }> =
	retainValidatedResponse(z.object({ ok: z.boolean() }).passthrough());

function retainValidatedResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>((value) => fields.safeParse(value).success);
}
