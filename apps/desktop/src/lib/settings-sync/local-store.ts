// Reading, writing, and — the load-bearing part — NOTICING local settings
// changes.
//
// The desktop writes settings from ~a hundred call sites through plain
// `localStorage.setItem`, and the DOM fires no event for a write made by the
// same document (`storage` only reaches OTHER windows). Chasing every call site
// to add a notification would be a huge diff that the next new setting would
// immediately fall out of.
//
// So this patches `localStorage.setItem` / `removeItem` once, exactly as
// `console-buffer.ts` patches `console`, and reports the writes that touch an
// allowlisted key. One seam, and a setting added later is picked up for free as
// soon as its key is allowlisted.
//
// Timestamps: every synced key carries its own `updatedAt`, because the merge is
// per-key last-writer-wins. Those live in one side map (`ryu:settings-sync-meta`)
// rather than being folded into the values, since the values belong to the
// features that own them and must keep their existing shape.

import { z } from "zod";
import { vaultAccountCount } from "@/lib/session-owner.ts";
import { ACCOUNT_CONTENT_KEYS, isSyncableKey, SYNCABLE_KEYS } from "./keys.ts";

/** Side map of `key -> unix ms of the last local change`. Not itself synced. */
const META_KEY = "ryu:settings-sync-meta";
const CACHE_KEY = "ryu:settings-sync-value-cache";
const VALUES_KEY_PREFIX = "ryu:settings-sync-values:";
const VISIBLE_OWNER_KEY = "ryu:settings-sync-visible-owner";
/**
 * Shared across every window: a counter that advances each time the visible
 * settings pass from one owner to another, and whether the values now visible
 * are the clean slate installed for "no account" (nothing any account wrote).
 */
const OWNER_EPOCH_KEY = "ryu:settings-sync-owner-epoch";

let settingsOwner: string | null = null;

interface OwnerEpoch {
	clean: boolean;
	epoch: number;
}

const ownerEpochSchema = z.object({
	clean: z.boolean(),
	epoch: z.number().int().nonnegative(),
});

function readOwnerEpoch(): OwnerEpoch {
	try {
		const raw = localStorage.getItem(OWNER_EPOCH_KEY);
		const parsed = raw ? ownerEpochSchema.safeParse(JSON.parse(raw)) : null;
		return parsed?.success ? parsed.data : { clean: false, epoch: 0 };
	} catch {
		return { clean: false, epoch: 0 };
	}
}

/**
 * The owner epoch whose values this window's features loaded.
 *
 * Captured once, when this module is evaluated: the same moment the
 * module-level stores (`useSplitPresetStore`, the theme presets, …) read their
 * values, and before any component mounts. It never advances. Features keep
 * synced values in memory in many shapes (zustand stores, React state, refs)
 * and write them back whole, so once the visible settings pass to another
 * owner nothing in this document can be trusted to hold only that owner's
 * values. Only a new document (a reload) loads them into every feature again.
 */
const loadedOwnerEpoch = readOwnerEpoch().epoch;
let staleWindowAnnounced = false;

function ownerKey(base: string, owner = settingsOwner): string {
	return owner ? `${base}:${encodeURIComponent(owner)}` : base;
}

type MetaMap = Record<string, number | null>;

const timestampValueSchema = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const timestampMapSchema = z.record(
	z.string(),
	timestampValueSchema.nullable()
);
// Keep native own keys and object identity after validating the entire map.
const localTimestampMapSchema = z.custom<MetaMap>(
	(value) => timestampMapSchema.safeParse(value).success
);
const cachedValueMapSchema = z.record(z.string(), z.string());
const localCachedValueMapSchema = z.custom<Record<string, string>>(
	(value) => cachedValueMapSchema.safeParse(value).success
);

function readMeta(): MetaMap {
	try {
		const raw = localStorage.getItem(ownerKey(META_KEY));
		return raw ? localTimestampMapSchema.parse(JSON.parse(raw)) : {};
	} catch {
		return {};
	}
}

function writeMeta(meta: MetaMap): void {
	try {
		// Uses the ORIGINAL setter: writing meta must never look like a settings
		// change, or every push would dirty the map it just wrote and loop.
		(originalSetItem ?? localStorage.setItem).call(
			localStorage,
			ownerKey(META_KEY),
			JSON.stringify(meta)
		);
		if (settingsOwner) {
			(originalSetItem ?? localStorage.setItem).call(
				localStorage,
				META_KEY,
				JSON.stringify(meta)
			);
		}
	} catch {
		// Best-effort: a full quota means timestamps degrade, not that sync breaks.
	}
}

/** The whole timestamp map. Used at startup to rebuild the pending set. */
export function allLocalTimestamps(): MetaMap {
	return readMeta();
}

/**
 * A synchronously-readable cache of the values that do NOT live in local
 * storage — currently just the keyboard shortcuts, which live in Core's
 * preference store behind an HTTP call.
 *
 * It exists for exactly one caller: the flush that runs while the window is
 * closing. That path cannot await anything — the document is gone before a
 * promise resolves, so the request would never be made at all — and the change a
 * user makes seconds before quitting is the one they notice missing.
 */
export function readCachedValue(key: string): string | null {
	try {
		const raw = localStorage.getItem(ownerKey(CACHE_KEY));
		const cache = raw ? localCachedValueMapSchema.parse(JSON.parse(raw)) : {};
		return cache[key] ?? null;
	} catch {
		return null;
	}
}

export function writeCachedValue(key: string, value: string | null): void {
	try {
		const raw = localStorage.getItem(ownerKey(CACHE_KEY));
		const cache = raw ? localCachedValueMapSchema.parse(JSON.parse(raw)) : {};
		if (value === null) {
			delete cache[key];
		} else {
			cache[key] = value;
		}
		(originalSetItem ?? localStorage.setItem).call(
			localStorage,
			ownerKey(CACHE_KEY),
			JSON.stringify(cache)
		);
		if (settingsOwner) {
			(originalSetItem ?? localStorage.setItem).call(
				localStorage,
				CACHE_KEY,
				JSON.stringify(cache)
			);
		}
	} catch {
		// Best-effort: a miss degrades the close-time flush, not sync itself.
	}
}

/** Unix ms of the last local change to `key`, or 0 if never recorded. */
export function localTimestamp(key: string): number {
	return readMeta()[key] ?? 0;
}

/** Record that `key` changed locally at `at`. */
export function markLocalChange(key: string, at: number = Date.now()): void {
	const meta = readMeta();
	meta[key] = at;
	writeMeta(meta);
}

/** Current local value of a synced key, or null when unset. */
export function readLocal(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function snapshotValues(): Record<string, string> {
	const values: Record<string, string> = {};
	for (const { key } of SYNCABLE_KEYS) {
		const value = readLocal(key);
		if (value !== null) {
			values[key] = value;
		}
	}
	return values;
}

/**
 * Marks visible settings that no account may claim: they were left behind by a
 * sign-out or an unverified session. Written by the auth client too.
 */
export const UNOWNED_VISIBLE_SETTINGS = "unowned-transition";

function valuesKey(owner: string): string {
	return `${VALUES_KEY_PREFIX}${encodeURIComponent(owner)}`;
}

function recordedVisibleOwner(): string | null {
	try {
		return localStorage.getItem(VISIBLE_OWNER_KEY);
	} catch {
		return UNOWNED_VISIBLE_SETTINGS;
	}
}

/**
 * The account whose values are visible right now. The shared record is the
 * source of truth, not this window's loaded owner: every window of the app
 * shares one storage area, and another window may already have saved this
 * owner's values and installed another account's. Only a store from before the
 * record existed falls back to the loaded owner.
 */
function currentVisibleOwner(): string | null {
	const recorded = recordedVisibleOwner();
	if (recorded === null) {
		return settingsOwner;
	}
	return recorded === UNOWNED_VISIBLE_SETTINGS ? null : recorded;
}

/**
 * Whether the visible settings are this window's loaded owner's, so a write to
 * them is that owner's edit. False once another window has switched the shared
 * storage to another account (or is mid-switch): those writes are that
 * account's values and must not be stamped, journaled or saved for this one.
 */
export function ownsVisibleSettings(): boolean {
	const recorded = recordedVisibleOwner();
	if (settingsOwner === null) {
		// Unattributed state may be stamped only while no account's values are
		// installed; it is claimed later solely under the cold-start rule.
		return recorded === null || recorded === UNOWNED_VISIBLE_SETTINGS;
	}
	return recorded === null || recorded === settingsOwner;
}

/**
 * How much of the already-visible state an activation may take over:
 *
 * - `true`: the visible values AND their delivery bookkeeping (timestamps,
 *   cache) are proven to be `nextOwner`'s, because the shared record names it
 *   (a restart of the same account).
 * - `"values"`: a store from before the record existed. Its values are
 *   whatever every account on this profile saw, so they stay on screen, but
 *   their timestamps are dropped: an earlier build kept one ownerless pending
 *   set across account switches and sign-outs, so a stamped legacy change may
 *   be another account's unsent edit and must not become this account's
 *   upload. The account's cloud copy wins on its first pull instead.
 * - `"portable-values"`: the same, on a pre-scoping store whose vault holds
 *   several accounts. The values that carry account-authored content
 *   (`accountContent` in `keys.ts`: sidebar sections, split layouts, custom
 *   themes) may be another signed-in account's, so they are not kept for
 *   anyone; the account's cloud copy fills them on its first pull.
 * - `false`: nothing is claimed.
 */
export type VisibleSettingsClaim = boolean | "values" | "portable-values";

/**
 * Persist the old account's visible settings and synchronously install the new
 * account's values before its bearer becomes active. The first activation
 * claims the already-visible values for the already-active account only.
 *
 * With a claim (see `VisibleSettingsClaim`), the visible values are
 * authoritative over any older saved snapshot of that account.
 */
export function activateSettingsOwner(
	nextOwner: string | null,
	claimVisibleValues: VisibleSettingsClaim = false
): void {
	if (settingsOwner === nextOwner) {
		return;
	}
	const set = originalSetItem ?? localStorage.setItem;
	const remove = originalRemoveItem ?? localStorage.removeItem;
	// Whose values are visible right now, by the shared record: after another
	// window's switch they are no longer this window's loaded owner's, and saving
	// them under that owner would hand it the other account's settings.
	const visibleOwner = currentVisibleOwner();
	const claim = claimVisibleValues !== false && nextOwner !== null;
	// Only a proven claim carries the unscoped timestamps and cache along.
	const claimBookkeeping = claimVisibleValues === true && nextOwner !== null;
	const previousValues = snapshotValues();
	// Unattributable account content is withdrawn before anything is claimed.
	const withdrawn =
		claim && claimVisibleValues === "portable-values"
			? ACCOUNT_CONTENT_KEYS.filter((key) => previousValues[key] !== undefined)
			: [];
	// The visible values pass to another owner unless this activation claims
	// them, another window already installed `nextOwner`'s, or they are the
	// clean "no account" slate (which holds nothing any account wrote). Every
	// window whose features loaded the previous owner's values is now stale.
	const epoch = readOwnerEpoch();
	const valuesChangeHands =
		withdrawn.length > 0 ||
		(!claim &&
			visibleOwner !== nextOwner &&
			!(epoch.clean && visibleOwner === null));
	const nextEpoch: OwnerEpoch = valuesChangeHands
		? { clean: nextOwner === null, epoch: epoch.epoch + 1 }
		: { clean: nextOwner === null && epoch.clean, epoch: epoch.epoch };
	if (nextEpoch.epoch !== epoch.epoch || nextEpoch.clean !== epoch.clean) {
		// Before the first value moves, so a write any window makes from here on
		// is already judged against the new epoch.
		set.call(localStorage, OWNER_EPOCH_KEY, JSON.stringify(nextEpoch));
	}
	for (const key of withdrawn) {
		remove.call(localStorage, key);
	}
	if (visibleOwner && !(claim && visibleOwner === nextOwner)) {
		set.call(
			localStorage,
			valuesKey(visibleOwner),
			JSON.stringify(snapshotValues())
		);
	}
	// Mid-switch the visible keys hold neither account's complete values; other
	// windows must not attribute the writes below to anyone until the record
	// names the new owner.
	set.call(localStorage, VISIBLE_OWNER_KEY, UNOWNED_VISIBLE_SETTINGS);

	if (nextOwner) {
		if (claim || localStorage.getItem(valuesKey(nextOwner)) === null) {
			set.call(
				localStorage,
				valuesKey(nextOwner),
				JSON.stringify(claim ? snapshotValues() : {})
			);
		}
		for (const base of [META_KEY, CACHE_KEY]) {
			const scoped = ownerKey(base, nextOwner);
			const legacy = claimBookkeeping ? localStorage.getItem(base) : null;
			if (legacy !== null) {
				set.call(localStorage, scoped, legacy);
			} else if (localStorage.getItem(scoped) === null) {
				set.call(localStorage, scoped, "{}");
			}
		}
	}

	settingsOwner = nextOwner;
	const nextValues = (() => {
		if (!nextOwner) {
			return {};
		}
		try {
			const raw = localStorage.getItem(valuesKey(nextOwner));
			return raw ? localCachedValueMapSchema.parse(JSON.parse(raw)) : {};
		} catch {
			return {};
		}
	})();
	for (const { key } of SYNCABLE_KEYS) {
		const value = nextValues[key];
		if (value === undefined) {
			remove.call(localStorage, key);
		} else {
			set.call(localStorage, key, value);
		}
	}
	for (const base of [META_KEY, CACHE_KEY]) {
		const scopedValue = nextOwner
			? (localStorage.getItem(ownerKey(base)) ?? "{}")
			: "{}";
		set.call(localStorage, base, scopedValue);
	}
	// Recorded only once the visible values really are this owner's.
	set.call(
		localStorage,
		VISIBLE_OWNER_KEY,
		nextOwner ?? UNOWNED_VISIBLE_SETTINGS
	);
	// The values were replaced through the original setter, so this window got
	// no event. A feature holding the old account's value in memory must adopt
	// the new one now: its next write would otherwise put the old account's
	// value back, stamped as this account's edit.
	for (const { key } of SYNCABLE_KEYS) {
		if ((nextValues[key] ?? null) !== (previousValues[key] ?? null)) {
			notifyRemoteApplied(key);
		}
	}
	announceIfStaleWindow();
}

/**
 * Forget the in-memory owner when the engine stops, after saving its visible
 * values. The visible-owner record is kept, so a restart for the same account
 * reclaims them and a restart for another account saves them to this one.
 */
export function releaseSettingsOwner(): void {
	if (!settingsOwner) {
		return;
	}
	if (currentVisibleOwner() !== settingsOwner) {
		// Another window already saved this owner's values and installed another
		// account's; those must not be saved as this owner's.
		settingsOwner = null;
		return;
	}
	(originalSetItem ?? localStorage.setItem).call(
		localStorage,
		valuesKey(settingsOwner),
		JSON.stringify(snapshotValues())
	);
	settingsOwner = null;
}

/**
 * Re-key the loaded owner's settings scope when the same session resolves to
 * its real account id (a legacy install's placeholder id). The visible values
 * are that session's, so they stay visible and become the new owner's.
 */
export function renameSettingsOwner(
	previousOwner: string,
	nextOwner: string
): void {
	if (settingsOwner !== previousOwner || previousOwner === nextOwner) {
		return;
	}
	const set = originalSetItem ?? localStorage.setItem;
	const remove = originalRemoveItem ?? localStorage.removeItem;
	const visible = currentVisibleOwner() === previousOwner;
	const saved = localStorage.getItem(valuesKey(previousOwner));
	if (visible || saved !== null) {
		// The visible values are this session's only while the record names it;
		// otherwise its saved scope moves and the visible values stay put.
		set.call(
			localStorage,
			valuesKey(nextOwner),
			visible ? JSON.stringify(snapshotValues()) : (saved ?? "{}")
		);
	}
	remove.call(localStorage, valuesKey(previousOwner));
	for (const base of [META_KEY, CACHE_KEY]) {
		const scoped =
			localStorage.getItem(ownerKey(base, previousOwner)) ??
			localStorage.getItem(base) ??
			"{}";
		set.call(localStorage, ownerKey(base, nextOwner), scoped);
		remove.call(localStorage, ownerKey(base, previousOwner));
	}
	settingsOwner = nextOwner;
	if (visible) {
		set.call(localStorage, VISIBLE_OWNER_KEY, nextOwner);
	}
}

export function getSettingsOwner(): string | null {
	return settingsOwner;
}

/**
 * What of the visible state this account may claim when it is activated
 * without a loaded owner (see `VisibleSettingsClaim`): all of it when the
 * shared record names it, only the values on a store from before the record,
 * and of those only the plain preferences when the vault holds several
 * accounts (any of which may have authored the sections or layouts on screen).
 */
export function visibleSettingsClaim(
	owner: string | null
): VisibleSettingsClaim {
	if (!owner) {
		return false;
	}
	const recorded = localStorage.getItem(VISIBLE_OWNER_KEY);
	if (recorded === owner) {
		return true;
	}
	if (recorded !== null) {
		return false;
	}
	return vaultAccountCount() > 1 ? "portable-values" : "values";
}

/** Whether the visible values can be attributed to this account at all. */
export function canClaimVisibleSettings(owner: string | null): boolean {
	return visibleSettingsClaim(owner) !== false;
}

/**
 * Write a value that came FROM the server.
 *
 * Uses the original setter and stamps the remote timestamp, so applying a remote
 * change does not read back as a fresh local change and bounce straight back up.
 */
export function applyRemote(
	key: string,
	value: string | null,
	updatedAt: number
): void {
	// A refused local write must reach the sync caller before it records the
	// remote timestamp, clears pending work, or reports a completed cycle.
	if (value === null) {
		(originalRemoveItem ?? localStorage.removeItem).call(localStorage, key);
	} else {
		(originalSetItem ?? localStorage.setItem).call(localStorage, key, value);
	}
	const meta = readMeta();
	meta[key] = updatedAt;
	writeMeta(meta);
	notifyRemoteApplied(key);
}

/**
 * Fired on `window` after a value from another device lands in localStorage.
 * The write goes through the ORIGINAL setter (so it is not echoed back as a
 * local change), which also means no `storage` event reaches this document; a
 * feature that keeps its setting in React state listens for this instead.
 */
export const SETTINGS_REMOTE_APPLIED_EVENT = "ryu:settings-remote-applied";

function notifyRemoteApplied(key: string): void {
	if (!("window" in globalThis && "CustomEvent" in globalThis)) {
		return;
	}
	try {
		window.dispatchEvent(
			new CustomEvent(SETTINGS_REMOTE_APPLIED_EVENT, { detail: { key } })
		);
	} catch {
		// A listener throwing must not fail the sync apply.
	}
}

// ── Change observation ───────────────────────────────────────────────────────

type ChangeListener = (key: string) => void;

const listeners = new Set<ChangeListener>();
let originalSetItem: typeof Storage.prototype.setItem | null = null;
let originalRemoveItem: typeof Storage.prototype.removeItem | null = null;
let installed = false;

const storageKeyListeners = new Set<(key: string) => void>();

/** Observe storage writes, including non-syncable identity keys, without
 * timestamping or uploading those keys. */
export function onStorageKeyChange(
	listener: (key: string) => void
): () => void {
	storageKeyListeners.add(listener);
	return () => storageKeyListeners.delete(listener);
}

function emitForeign(key: string): void {
	for (const listener of storageKeyListeners) {
		listener(key);
	}
}

/**
 * A write made by this document: stamp it and tell the sync engine. The
 * patched `setItem` / `removeItem` call it; code that writes through storage it
 * cannot patch (a test double) reports its edits here.
 */
export function observeLocalWrite(key: string): void {
	emitLocal(key);
}

function emitLocal(key: string): void {
	emitForeign(key);
	if (!isSyncableKey(key)) {
		return;
	}
	if (!ownsVisibleSettings()) {
		// Another window installed another account's values (or is mid-switch):
		// this write is not an edit by this window's account.
		return;
	}
	markLocalChange(key);
	for (const listener of listeners) {
		listener(key);
	}
}

/**
 * Fired on `window` once, when this window's features turn out to hold another
 * owner's settings in memory (see `isSettingsWindowStale`): in the window that
 * switched accounts and in every other window of the app. The app reloads the
 * window on it, which is what loads the new owner's values into every feature.
 */
export const SETTINGS_OWNER_CHANGED_EVENT = "ryu:settings-owner-changed";

/**
 * Whether the visible settings have passed to another owner since this
 * window's features loaded theirs. Sticky: following the switch (the engine
 * moving to the new account) does not make the in-memory copies fresh again;
 * only a reload does.
 */
export function isSettingsWindowStale(): boolean {
	return readOwnerEpoch().epoch !== loadedOwnerEpoch;
}

function announceIfStaleWindow(): void {
	if (!isSettingsWindowStale()) {
		// Only a cleared storage area returns to the loaded epoch.
		staleWindowAnnounced = false;
		return;
	}
	if (staleWindowAnnounced) {
		return;
	}
	staleWindowAnnounced = true;
	if (!("window" in globalThis && "CustomEvent" in globalThis)) {
		return;
	}
	try {
		window.dispatchEvent(new CustomEvent(SETTINGS_OWNER_CHANGED_EVENT));
	} catch {
		// A listener throwing must not fail the account transition.
	}
}

/**
 * Whether a feature write to an allowlisted key must be dropped because the
 * writer cannot be bound to the owner whose values are visible now.
 *
 * This is the one choke point every synced-key write passes through, so the
 * binding is made here rather than in each feature: a feature's in-memory copy
 * of a synced value (a zustand store loaded at module evaluation, React state,
 * a ref) was loaded under this window's owner epoch. Once the visible settings
 * pass to another owner, in this window or another, writing that copy back
 * would put the previous account's settings (layout names, sidebar section
 * names, conversation ids) into the next account's values, to be saved and
 * uploaded as its own. Such writes are dropped until the window reloads, and
 * so are writes made while another window has moved the shared storage to an
 * account this window has not followed yet (or is mid-switch).
 */
export function isStaleWindowWrite(key: string): boolean {
	if (!isSyncableKey(key)) {
		return false;
	}
	if (isSettingsWindowStale()) {
		announceIfStaleWindow();
		return true;
	}
	return settingsOwner !== null && !ownsVisibleSettings();
}

/**
 * Patch localStorage so writes to allowlisted keys are observable, and pick up
 * writes from sibling windows via the `storage` event. Idempotent.
 *
 * The patch always forwards to the original method first, so a failure in a
 * listener can never stop a setting from being saved.
 */
export function installSettingsObserver(): void {
	if (installed) {
		return;
	}
	installed = true;
	originalSetItem = localStorage.setItem.bind(localStorage);
	originalRemoveItem = localStorage.removeItem.bind(localStorage);

	localStorage.setItem = function patchedSetItem(
		key: string,
		value: string
	): void {
		if (isStaleWindowWrite(key)) {
			return;
		}
		originalSetItem?.call(localStorage, key, value);
		emitLocal(key);
	};
	localStorage.removeItem = function patchedRemoveItem(key: string): void {
		if (isStaleWindowWrite(key)) {
			return;
		}
		originalRemoveItem?.call(localStorage, key);
		emitLocal(key);
	};

	// A write from another window of this app (`storage` does not fire in the
	// window that made it). Only identity observers hear it: the writing window
	// already stamped the key and owns pushing it, and a value it applied from
	// the cloud carries the remote time. Re-stamping it here would make this
	// window push it again as a newer local edit, over a later remote change.
	window.addEventListener("storage", (event) => {
		if (event.key === OWNER_EPOCH_KEY || event.key === null) {
			// Another window moved the visible settings to another owner.
			announceIfStaleWindow();
		}
		if (event.key) {
			emitForeign(event.key);
		}
	});
}

/** Subscribe to allowlisted local settings changes. */
export function onSettingsChange(listener: ChangeListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Whether the observer is active (the settings UI reports this). */
export function isSettingsObserverInstalled(): boolean {
	return installed;
}
