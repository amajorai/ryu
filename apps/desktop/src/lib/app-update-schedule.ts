// apps/desktop/src/lib/app-update-schedule.ts
//
// Deferring THIS APP'S OWN update to the machine's next quiet hour.
//
// The sibling of `scheduleNodeUpdate` in `lib/api/update.ts`, and deliberately
// NOT the same thing. That one defers a REMOTE node's update: it POSTs to that
// node's Core, the quiet hour is computed in the NODE's zone, and the node's own
// 30s tick installs it. This one defers the desktop bundle, so the machine that
// restarts is this one, the zone is this machine's, and the record is local.
//
// WHAT WE MAY PROMISE, AND WHY IT IS NOT "AT 03:00". A node is a server: it is
// awake at the quiet hour, so "installs at 03:00" is true there. A laptop is
// asleep, or quit, or both, and nothing in this bundle registers a wake or a
// calendar launch — `tauri-plugin-autostart` registers launch-at-LOGIN, not
// launch-at-a-TIME. So the truthful sentence is "the next time you open Ryu
// after 03:00", with an immediate install if the app happens to be running and
// awake when the window arrives. `describePendingAppUpdate` is the one place
// that sentence is written, so no surface can accidentally promise more.
//
// THE QUIET HOUR IS COMPUTED HERE, NOT IN RUST. The Tauri crate has no timezone
// database (no `chrono-tz`), and it does not need one: unlike a node, this
// machine's own local time IS the relevant zone, which the platform already
// knows. So this file resolves an absolute instant and Rust stores it — a plain
// wall-clock number, immune to a DST change between booking and the window.

import { invoke } from "@tauri-apps/api/core";
import type { UpdateCheck } from "@/src/lib/api/update.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";

/** The hour a deferred install targets, in the machine's own local zone. */
const QUIET_HOUR = 3;

/**
 * Too close to be worth deferring to. Telling someone "tonight" and restarting
 * them four minutes later is worse than not offering the choice. Matches Core's
 * `MIN_LEAD_MINUTES`.
 */
const MIN_LEAD_MINUTES = 15;

const MINUTE_MS = 60 * 1000;

/** Matches the Rust `update_schedule::PendingAppUpdate`. */
export interface PendingAppUpdate {
	/** Epoch milliseconds UTC. */
	scheduled_for_ms: number;
	/** Display only — the zone the quiet hour was computed in. */
	time_zone: string;
	/** The whole verdict the user was shown, pinned verbatim. */
	verdict: UpdateCheck;
	version: string;
}

/** This machine's IANA zone, or `UTC` when the runtime cannot name it. */
export function localTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/**
 * The next `QUIET_HOUR` in local time, strictly after `now` plus the lead
 * margin.
 *
 * DST is handled the same way Core's `next_quiet_window` handles it, and for
 * the same two nights:
 *
 *   - Spring forward, where the target hour does not exist. `new Date(y, m, d,
 *     3, …)` silently NORMALISES a missing local hour to a real one, which
 *     would invent an instant the user was never offered — so a day whose
 *     resolved hour is not `QUIET_HOUR` is skipped to the next day instead,
 *     matching Core's `LocalResult::None` arm.
 *   - Fall back, where it exists twice. The constructor resolves to the EARLIER
 *     occurrence, which is Core's `Ambiguous(first, _)` choice, and is still
 *     genuinely quiet.
 */
export function nextQuietWindow(now: Date) {
	const earliest = now.getTime() + MIN_LEAD_MINUTES * MINUTE_MS;
	for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
		const candidate = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() + dayOffset,
			QUIET_HOUR,
			0,
			0,
			0
		);
		// The hour does not exist on this date (spring forward) and the runtime
		// moved it. Try tomorrow rather than installing at an hour nobody chose.
		if (candidate.getHours() !== QUIET_HOUR) {
			continue;
		}
		if (candidate.getTime() > earliest) {
			return { at: candidate, timeZone: localTimeZone() };
		}
	}
	// Every candidate was unusable — only reachable if the local calendar is far
	// stranger than any real zone. Fall back to the lead margin rather than
	// refusing to defer at all.
	return { at: new Date(earliest), timeZone: localTimeZone() };
}

/**
 * The sentence shown wherever a booked install is named.
 *
 * ONE implementation, because the promise is the part that is easy to get
 * wrong. "will install at 03:00" is what the node surface says and it is true
 * there; saying it here would be a promise this app cannot keep on a laptop
 * that is asleep at the hour.
 */
export function describePendingAppUpdate(pending: PendingAppUpdate): string {
	const when = formatDateTime(pending.scheduled_for_ms);
	return `v${pending.version} will install the next time you open Ryu after ${when} (${pending.time_zone}).`;
}

/** The booked install, or `null`. Never throws — outside Tauri there is none. */
export async function getPendingAppUpdate(): Promise<PendingAppUpdate | null> {
	try {
		return (
			(await invoke<PendingAppUpdate | null>("get_pending_app_update")) ?? null
		);
	} catch {
		return null;
	}
}

/**
 * The booked install if its window has passed, else `null`.
 *
 * Answered in Rust so the comparison is against the OS clock rather than
 * anything the webview holds: the app is normally not running at the quiet
 * hour, so this is read at launch, hours or days late, which is the expected
 * case and not a failure.
 */
export async function dueAppUpdate(): Promise<PendingAppUpdate | null> {
	try {
		return (await invoke<PendingAppUpdate | null>("due_app_update")) ?? null;
	} catch {
		return null;
	}
}

/**
 * Book this update for the machine's next quiet hour.
 *
 * The whole verdict is pinned, not just the version: at the window the install
 * uses this record rather than re-checking, so what lands is the build the user
 * actually saw. Re-resolving would hand over whatever is newest at 03:00 —
 * different notes, a different version, on a machine they deliberately chose not
 * to touch during the day.
 *
 * Throws when the record cannot be written; the caller must surface that rather
 * than reporting a deferral that was never stored.
 */
export async function scheduleAppUpdate(
	verdict: UpdateCheck,
	now: Date = new Date()
): Promise<PendingAppUpdate> {
	const { at, timeZone } = nextQuietWindow(now);
	const pending: PendingAppUpdate = {
		scheduled_for_ms: at.getTime(),
		time_zone: timeZone,
		verdict,
		version: verdict.latest,
	};
	return await invoke<PendingAppUpdate>("set_pending_app_update", { pending });
}

/**
 * Cancel the booked install. Idempotent. Returns whether the record is now
 * gone.
 *
 * THE RETURN VALUE IS LOAD-BEARING, not a courtesy. The install path clears
 * BEFORE installing, because installing relaunches and no later line runs. If
 * clearing silently fails and the caller installs anyway, the record is still
 * due at the next launch — and at every launch after that, forever, each one
 * re-running an install that has nothing left to do and suppressing the real
 * update check behind it. A caller that cannot clear must not proceed.
 */
export async function clearPendingAppUpdate(): Promise<boolean> {
	try {
		await invoke("clear_pending_app_update");
		return true;
	} catch {
		return false;
	}
}
