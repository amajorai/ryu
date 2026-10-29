// apps/desktop/src/lib/updates-window.ts
//
// The active account's lifetime "1 year of updates" window, mirrored locally so
// the updater can read it. A desktop licence is PERPETUAL: this window governs
// only WHICH BUILDS are offered, never whether the app runs. Nothing here may
// ever reach the paywall verdict.
//
// Why localStorage rather than the entitlement context: six independent call
// sites reach `checkForUpdate`, the launch-time updater runs before
// `useEntitlement` has resolved, and the last-known window has to survive an
// offline launch. Like `release-channel.ts`, this is a synchronous value the
// updater reads without prop-threading or awaiting an async resolve.
//
// Why the window end is stored while it is still OPEN: it is written only when
// the entitlement check succeeds. Were it written only once LAPSED, the very
// first post-lapse launch would race that check — the updater would find no key,
// send no cutoff, and auto-install one build past the ceiling. Storing it early
// and applying the lapse test at READ time removes the race at zero cost.
//
// Why every read is scoped to the active account: signing out clears the auth
// vault (`ryu_accounts` / `ryu_active_user_id`) but not this key, so an unscoped
// value would clamp the next person to sign in on the machine and show them
// billing copy about a licence they do not own. Scoping on read makes sign-out,
// full logout and account switching all correct without a single teardown call.
//
// KNOWN AND ACCEPTED — the one-launch staleness window. The record carries no
// freshness stamp, and the launch-time updater reads it synchronously before
// `useEntitlement.resolve()` has re-fetched the entitlement. So on the FIRST
// launch after an owner renews (or after they take a subscription, which exempts
// them via `updatesWindowApplies`), the previous lapsed value can still clamp
// that one check. It self-heals the moment the resolve lands and is corrected
// for every later launch. This is deliberate: the alternative is either blocking
// launch on a network round-trip, or expiring the record — which would drop the
// window exactly when an OFFLINE owner needs it, trading a one-launch clamp for
// a fail-open hole. Renewing owners can force it immediately with the Check for
// updates button in Settings, which re-reads after the resolve.

import { updatesCutoffMs } from "@ryu/auth/lib/plans";
import type { z } from "zod";
import { getActiveUserId } from "@/lib/auth-client.ts";
import { formatDate } from "@/src/lib/timezone.ts";
import {
	type NagRecord,
	parseScopedUpdatesRecord,
	updatesNagRecordSchema,
	updatesWindowRecordSchema,
	type WindowRecord,
} from "./updates-window-records.ts";

/** localStorage key: `{ accountId, windowEndsAt }` for the active account. */
const UPDATES_WINDOW_KEY = "ryu.updates-window";

/** localStorage key: `{ accountId, version }` — the last version nagged about. */
const UPDATES_NAG_KEY = "ryu.updates-nag";

/**
 * Read a stored record and hand it back only when it belongs to the account that
 * is signed in right now. A missing, unparseable, foreign or unowned record is
 * indistinguishable from "no record", which is the fail-open direction for every
 * caller below.
 */
function readScopedRecord<T extends { accountId: string }>(
	key: string,
	schema: z.ZodType<T>
): T | null {
	const activeId = getActiveUserId();
	if (activeId === null) {
		return null;
	}
	try {
		return parseScopedUpdatesRecord(
			localStorage.getItem(key),
			activeId,
			schema
		);
	} catch {
		return null;
	}
}

/**
 * Persist (or clear) the RFC-3339 END of the active account's lifetime updates
 * window. Best-effort; storage failures are swallowed so a blocked or full store
 * can never break the entitlement resolve that called us.
 */
export function setUpdatesWindow(windowEndsAtIso: string | null): void {
	try {
		if (windowEndsAtIso === null) {
			localStorage.removeItem(UPDATES_WINDOW_KEY);
			return;
		}
		const accountId = getActiveUserId();
		if (accountId === null) {
			return;
		}
		const record: WindowRecord = { accountId, windowEndsAt: windowEndsAtIso };
		localStorage.setItem(UPDATES_WINDOW_KEY, JSON.stringify(record));
	} catch {
		// Persistence is best-effort.
	}
}

/**
 * The active account's window end, or null when none is stored, the stored
 * record belongs to another account, or the value does not parse. NOT
 * lapse-aware — this is the date to DISPLAY.
 */
export function getUpdatesWindowEnd(): string | null {
	const record = readScopedRecord(
		UPDATES_WINDOW_KEY,
		updatesWindowRecordSchema
	);
	const windowEndsAt = record?.windowEndsAt;
	if (windowEndsAt === undefined) {
		return null;
	}
	// One corrupted date must not poison every later check, and it must never
	// reach the callers below as a NaN cutoff.
	return Number.isFinite(Date.parse(windowEndsAt)) ? windowEndsAt : null;
}

/** The same instant as epoch ms, or null. Used by the install-time guard. */
export function getUpdatesCutoffMs(): number | null {
	const end = getUpdatesWindowEnd();
	if (end === null) {
		return null;
	}
	const cutoffMs = updatesCutoffMs(Date.parse(end));
	// A window that has not closed yet cannot exclude a release that already
	// exists, so an in-window owner sends nothing and takes the exact code path
	// every free and subscribed user takes.
	return Date.now() > cutoffMs ? cutoffMs : null;
}

/**
 * The cutoff to SEND to Core: the grace-inclusive instant, and only once the
 * window has actually lapsed. The skew grace is added exactly once, upstream in
 * `updatesCutoffMs` — never again here or downstream.
 */
export function getUpdatesCutoff(): string | null {
	const cutoffMs = getUpdatesCutoffMs();
	return cutoffMs === null ? null : new Date(cutoffMs).toISOString();
}

/**
 * Human date for a window end. Deliberately the same locale options BillingTab
 * already passes for `updatesExpiresAt`, so the two surfaces can never disagree
 * about the date a user's updates run to.
 */
export function formatUpdatesCutoff(iso: string): string {
	return formatDate(iso, {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

/**
 * Whether the lapsed-window prompt has already been shown for this version. One
 * prompt per newly-published version — not one per launch. Defaults to showing
 * it: only an exact account + version match suppresses.
 */
export function shouldNagForVersion(version: string): boolean {
	const record = readScopedRecord(UPDATES_NAG_KEY, updatesNagRecordSchema);
	return record?.version !== version;
}

export function markNaggedForVersion(version: string): void {
	try {
		const accountId = getActiveUserId();
		if (accountId === null) {
			return;
		}
		const record: NagRecord = { accountId, version };
		localStorage.setItem(UPDATES_NAG_KEY, JSON.stringify(record));
	} catch {
		// Best-effort: at worst the same version prompts once more next launch.
	}
}
