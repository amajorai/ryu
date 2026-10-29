// The settings-sync engine: what pushes, when it pushes, and what happens when
// two machines disagree.
//
// TIMING. A settings change is a burst, not an event — dragging a slider or
// walking down a list of switches produces dozens of writes in a few seconds.
// So a change starts a debounce timer and every further change RESTARTS it: the
// upload happens once the user stops fiddling, not once per keystroke. Anything
// still pending when the window closes is flushed with a keepalive request,
// because a change made twenty seconds before quitting is exactly the change a
// user would notice missing on the other machine. That flush is SYNCHRONOUS all
// the way down — awaiting anything inside a `pagehide` handler means the request
// is never made at all, which `keepalive` cannot rescue because there is nothing
// to keep alive. The pending set is also rebuilt from disk at startup, so a
// change that never got its debounce (a crash, a force-quit) is still owed and
// still sent.
//
// READING. `EventSource` cannot carry an Authorization header, and this API
// authenticates by bearer, so the live SSE feed the server exposes is not usable
// from here without a token-in-URL scheme that would put a credential in server
// logs. Sync therefore PULLS: on start, when the window regains focus, and on a
// slow background interval. Settings are not chat — a minute of staleness costs
// nothing, and a change you make on the machine you are looking at is applied
// instantly by the feature that owns it, not by sync.
//
// CONFLICTS. The merge is per-key last-writer-wins, and for the ordinary case
// that is the whole story: a key you have not touched since the last sync is
// simply overwritten by a newer remote value. A CONFLICT is narrower and worth a
// prompt — the same key changed on both machines since they last agreed. The
// default policy is to ask, because silently discarding one side is how people
// lose work they cannot see they lost. `download` and `upload` exist for users
// who have decided which machine is authoritative.
//
// SAFETY. Keys are filtered through the allowlist on BOTH directions. A value
// arriving from the server for a key that is not allowlisted here is dropped —
// an older or newer client, or a tampered response, must not be able to write
// arbitrary storage keys on this machine.

import type { Overrides } from "@ryu/hotkeys/registry";
import { z } from "zod";
import { onBeforeAccountIdentityChange } from "@/lib/account-transition.ts";
import {
	getActiveToken,
	onActiveTokenChange,
	TOKEN_KEY,
} from "@/lib/auth-client.ts";
import { getVerifiedActiveUserId } from "@/lib/session-owner.ts";
import { type ApiTarget, apiUrl, toTarget } from "@/src/lib/api/client.ts";
import { setKeybindings } from "@/src/lib/api/preferences.ts";
import { KEYBINDINGS_EDIT_EVENT } from "@/src/lib/hotkeys/storage.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	flushSettings,
	pullSettings,
	pushSettings,
	type SyncEntry,
	type SyncIdentity,
} from "./api.ts";
import {
	currentPlatform,
	isKeybindingsKey,
	isSyncableKey,
	keybindingsKey,
	platformOfKeybindingsKey,
} from "./keys.ts";
import {
	activateSettingsOwner,
	allLocalTimestamps,
	applyRemote,
	getSettingsOwner,
	installSettingsObserver,
	localTimestamp,
	markLocalChange,
	onSettingsChange,
	onStorageKeyChange,
	ownsVisibleSettings,
	readCachedValue,
	readLocal,
	releaseSettingsOwner,
	renameSettingsOwner,
	type VisibleSettingsClaim,
	visibleSettingsClaim,
	writeCachedValue,
} from "./local-store.ts";

/** How long to wait after the LAST change before uploading. */
export const DEBOUNCE_MS = 60_000;

/** Background pull cadence. Slow on purpose — see the header. */
const POLL_MS = 5 * 60_000;

/** Same-process event the shortcut editors listen on for Core's new set. */
const KEYBINDINGS_EVENT = "ryu:keybindings-changed";

// ── Persisted engine settings (local to this machine, never synced) ──────────

const ENABLED_KEY = "ryu:settings-sync-enabled";
const POLICY_KEY = "ryu:settings-sync-policy";
const CURSOR_KEY = "ryu:settings-sync-cursor";
const LAST_SYNC_KEY = "ryu:settings-sync-last";
const PENDING_LOCAL_KEY = "ryu:settings-sync-pending-local";
/** Per owner: the next pull starts at the beginning of the account's document
 *  (the shortcut scope changed), without moving the cursor. */
const FULL_PULL_KEY = "ryu:settings-sync-full-pull";

function scopedEngineKey(key: string, owner = getSettingsOwner()): string {
	return owner ? `${key}:${encodeURIComponent(owner)}` : key;
}

function readOwnedString(key: string): string | null {
	return readString(scopedEngineKey(key));
}

function writeOwnedString(key: string, value: string): void {
	if (getSettingsOwner() !== null && !ownsVisibleSettings()) {
		// Another window moved the shared storage to another account; this
		// window's state is stale and must not re-create or rewrite the scope of
		// an account that was switched away from or signed out there.
		return;
	}
	writeString(scopedEngineKey(key), value);
	if (getSettingsOwner()) {
		// Keep the legacy slot as a compatibility view of the active account.
		writeString(key, value);
	}
}

function activateEngineOwner(
	nextOwner: string | null,
	claimLegacy: VisibleSettingsClaim
): void {
	if (getSettingsOwner() === nextOwner) {
		return;
	}
	for (const [key, fallback] of [
		[CURSOR_KEY, "0"],
		[LAST_SYNC_KEY, "0"],
		[PENDING_LOCAL_KEY, "{}"],
	] as const) {
		if (!nextOwner) {
			continue;
		}
		const scoped = scopedEngineKey(key, nextOwner);
		if (readString(scoped) === null) {
			// The unscoped cursor and pending journal are delivery state: they
			// move only with a proven claim, never with a pre-scoping store's
			// values (whose pending work may be another account's).
			writeString(
				scoped,
				claimLegacy === true ? (readString(key) ?? fallback) : fallback
			);
		}
	}
	activateSettingsOwner(nextOwner, claimLegacy);
	if (nextOwner) {
		migrateShortcutCapture(nextOwner);
	}
	for (const [key, fallback] of [
		[CURSOR_KEY, "0"],
		[LAST_SYNC_KEY, "0"],
		[PENDING_LOCAL_KEY, "{}"],
	] as const) {
		writeString(key, nextOwner ? (readOwnedString(key) ?? fallback) : fallback);
	}
}

/** What to do when the same setting changed in two places. */
export type ConflictPolicy = "ask" | "download" | "upload";

function readString(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeString(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Best-effort.
	}
}

/** Whether this machine participates in sync. Opt-in: uploading a user's
 *  configuration to the cloud is not something to start doing unasked. */
export function isSyncEnabled(): boolean {
	return readString(ENABLED_KEY) === "true";
}

export function setSyncEnabled(enabled: boolean): void {
	if (!enabled) {
		resumeRequested = false;
	}
	cycleGeneration++;
	status = "idle";
	writeString(ENABLED_KEY, enabled ? "true" : "false");
	notify();
	if (enabled) {
		// Settings changed while sync was opted out still have durable local
		// timestamps. Rebuild the pending set at the opt-in boundary so enabling
		// sync uploads those changes instead of only watching future writes.
		seedDirtyFromDisk();
		void syncNow();
	}
}

export function getConflictPolicy(): ConflictPolicy {
	const raw = readString(POLICY_KEY);
	return raw === "download" || raw === "upload" ? raw : "ask";
}

export function setConflictPolicy(policy: ConflictPolicy): void {
	writeString(POLICY_KEY, policy);
	notify();
}

/** Server `updatedAt` this machine has already seen. */
function cursor(): number {
	const raw = Number(readOwnedString(CURSOR_KEY));
	return Number.isFinite(raw) ? raw : 0;
}

function setCursor(value: number): void {
	writeOwnedString(CURSOR_KEY, String(value));
}

// The cursor is also the boundary `seedDirtyFromDisk` reads pending work by: a
// setting stamped after it changed here since the last agreed pull. A change of
// Core scope must re-read the whole document (the new node needs the account's
// shortcuts installed) but must not zero that boundary, or every setting ever
// stamped would look like a pending local edit the next time the pending set is
// rebuilt (a restart, or this account becoming active again after a switch) and
// would compete with the account's newer cloud values as a conflict.
function fullPullRequested(): boolean {
	return readString(scopedEngineKey(FULL_PULL_KEY)) !== null;
}

function setFullPullRequested(requested: boolean): void {
	if (getSettingsOwner() !== null && !ownsVisibleSettings()) {
		return;
	}
	const key = scopedEngineKey(FULL_PULL_KEY);
	if (requested) {
		writeString(key, "1");
		return;
	}
	try {
		localStorage.removeItem(key);
	} catch {
		// Best-effort: a stale request only re-reads the document once more.
	}
}

/** Unix ms of the last completed sync, or 0. */
export function lastSyncAt(): number {
	const raw = Number(readOwnedString(LAST_SYNC_KEY));
	return Number.isFinite(raw) ? raw : 0;
}

// ── Observable engine state ─────────────────────────────────────────────────

export interface SyncConflict {
	key: string;
	/** This machine's value and when it changed. */
	local: string | null;
	localAt: number;
	/** The server's value and when it changed. */
	remote: string | null;
	remoteAt: number;
}

export type SyncStatus = "idle" | "syncing" | "offline" | "conflict";

const listeners = new Set<() => void>();
let revision = 0;
let status: SyncStatus = "idle";
let conflicts: SyncConflict[] = [];
/** Keys changed locally and not yet accepted by the server. */
const dirty = new Set<string>();
// Current-account acknowledgements, not a second settings authoring store.
const acceptedLocalSnapshots = new Map<string, SyncEntry>();
let timer: ReturnType<typeof setTimeout> | null = null;
let poller: ReturnType<typeof setInterval> | null = null;
let started = false;
/** True while a sync cycle is running — see `syncNow`. */
let inFlight = false;
let resumeRequested = false;
let shortcutTarget: ApiTarget | null = null;
// Invalidates responses across opt-out, account ABA, and engine cleanup.
// The token is held only in a temporary cycle closure, never persisted as a key.
let cycleGeneration = 0;
const pendingShortcutScopes = new Map<
	string,
	{ value: string | null; at: number; journal: ShortcutDelta }
>();
function shortcutResource(target: ApiTarget): string | null {
	try {
		return apiUrl(target, "/api/preferences/keybindings");
	} catch {
		return null;
	}
}

/**
 * The account a request may act for: the live bearer must be the vault token of
 * the vault's active user, and that account's settings and pending work must be
 * the ones loaded. Anything else (a switch in progress, a bearer whose profile
 * is unresolved, a stopped engine) yields no identity, so nothing collected for
 * one account is sent, or pulled into its scope, as another.
 */
function activeSyncIdentity(): SyncIdentity | null {
	const token = getActiveToken();
	const userId = getVerifiedActiveUserId();
	if (
		!(token && userId) ||
		getSettingsOwner() !== userId ||
		!ownsVisibleSettings()
	) {
		return null;
	}
	return { token, userId };
}

/** Snapshot of the identity settings sync currently acts for, or null. */
export function getActiveSyncIdentity(): SyncIdentity | null {
	return activeSyncIdentity();
}

function currentCycle(identity = activeSyncIdentity()): () => boolean {
	const generation = cycleGeneration;
	const target = activeTarget();
	return () =>
		generation === cycleGeneration &&
		identity !== null &&
		getSettingsOwner() === identity.userId &&
		ownsVisibleSettings() &&
		getVerifiedActiveUserId() === identity.userId &&
		getActiveToken() === identity.token &&
		isSyncEnabled() &&
		activeTarget().url === target.url &&
		activeTarget().token === target.token &&
		activeTarget().userJwt === target.userJwt;
}

function notify(): void {
	revision++;
	for (const listener of listeners) {
		listener();
	}
}

export function subscribeSyncState(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getSyncRevision(): number {
	return revision;
}

export function getSyncStatus(): SyncStatus {
	return status;
}

export function getConflicts(): readonly SyncConflict[] {
	return conflicts;
}

export function getPendingCount(): number {
	const unresolvedKeys = new Set(conflicts.map((conflict) => conflict.key));
	let pending = 0;
	for (const key of dirty) {
		if (!unresolvedKeys.has(key)) {
			pending++;
		}
	}
	return pending;
}

// ── Keybindings (Core preference, per OS) ───────────────────────────────────

function activeTarget() {
	return toTarget(useNodeStore.getState().getActiveNode());
}

// ACCOUNT SEPARATION. Core keeps ONE shortcut set per node, shared by every
// account signed in on this device, and an account switch does not swap it.
// What sync uploads for an account is therefore never read from Core, nor taken
// from a whole set an editor saved: an editor in another window, or one that
// missed a download, still holds a set with another account's overrides. It is
// the account's own set — its synced set as downloaded, plus exactly the
// overrides its own edits changed (`KeybindingsEdit`: the set each edit was
// made on and the result). While this device does not know the account's own
// synced set (a new device, a node switch, or a set captured before this rule),
// its edits wait in a journal, and the next cycle re-reads the account's set
// from the cloud before composing them onto it.

/** Per action: the override an edit set (a chord, or null for unbound), or
 *  null when it removed the override (back to the default). */
type ShortcutDelta = Record<string, { chord: string | null } | null>;

const overridesSchema = z.record(z.string(), z.string().nullable());
const shortcutEditSchema = z.object({
	after: overridesSchema,
	before: overridesSchema,
});
const shortcutDeltaSchema = z.record(
	z.string(),
	z.object({ chord: z.string().nullable() }).nullable()
);

/** Per owner: edits waiting for this device to learn the account's own set. */
const SHORTCUT_JOURNAL_KEY = "ryu:settings-sync-keybindings-journal";
/** Per owner: set once the owner's shortcut cache is held under this rule. */
const SHORTCUT_CAPTURE_KEY = "ryu:settings-sync-keybindings-capture";
const SHORTCUT_CAPTURE_VERSION = "2";
/** An earlier build's whole-set attribution record; read by nothing now. */
const RETIRED_SHORTCUT_ATTRIBUTION_KEY =
	"ryu:settings-sync-keybindings-attribution";

function parseOverrides(value: string | null | undefined): Overrides {
	if (!value) {
		return {};
	}
	try {
		const parsed = overridesSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

/** The overrides an edit changed: what differs between `before` and `after`. */
function shortcutDelta(before: Overrides, after: Overrides): ShortcutDelta {
	const delta: ShortcutDelta = {};
	for (const action of new Set([
		...Object.keys(before),
		...Object.keys(after),
	])) {
		const had = Object.hasOwn(before, action);
		const has = Object.hasOwn(after, action);
		if (had === has && before[action] === after[action]) {
			continue;
		}
		delta[action] = has ? { chord: after[action] ?? null } : null;
	}
	return delta;
}

/** `own` with an edit's changes applied; every other override left as it was. */
function applyShortcutDelta(own: Overrides, delta: ShortcutDelta): Overrides {
	const next: Overrides = { ...own };
	for (const [action, change] of Object.entries(delta)) {
		if (change === null) {
			delete next[action];
		} else {
			next[action] = change.chord;
		}
	}
	return next;
}

/** Whether this device knows the owner's own shortcut set (cached). */
function shortcutBaseKnown(): boolean {
	return readCachedValue(ownKeybindingsKey()) !== null;
}

function readShortcutJournal(): ShortcutDelta {
	try {
		const raw = readOwnedString(SHORTCUT_JOURNAL_KEY);
		const parsed = shortcutDeltaSchema.safeParse(raw ? JSON.parse(raw) : {});
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

/** Write (or, with null, clear) a value in the loaded owner's scope only. */
function writeOwnerScopedString(key: string, value: string | null): void {
	if (getSettingsOwner() === null || !ownsVisibleSettings()) {
		return;
	}
	if (value !== null) {
		writeString(scopedEngineKey(key), value);
		return;
	}
	try {
		localStorage.removeItem(scopedEngineKey(key));
	} catch {
		// Best-effort.
	}
}

function writeShortcutJournal(journal: ShortcutDelta | null): void {
	writeOwnerScopedString(
		SHORTCUT_JOURNAL_KEY,
		journal && Object.keys(journal).length > 0 ? JSON.stringify(journal) : null
	);
}

/**
 * A shortcut set cached for this owner before edits were captured as changes
 * may be a whole node-wide Core set (an earlier build cached Core's live set,
 * and a pre-scoping install's cache is claimed by whichever account starts
 * first). It is not provably this account's, so it is dropped: the next cycle
 * re-reads the account's own set from the cloud instead of uploading it.
 */
function migrateShortcutCapture(owner: string): void {
	const marker = scopedEngineKey(SHORTCUT_CAPTURE_KEY, owner);
	if (readString(marker) !== null) {
		return;
	}
	const key = ownKeybindingsKey();
	if (readCachedValue(key) !== null) {
		writeCachedValue(key, null);
	}
	writeString(marker, SHORTCUT_CAPTURE_VERSION);
}

/**
 * Compose the edits that waited for the owner's own synced set onto that set,
 * read from a pull that started at the beginning of the account's document.
 * When the set is news to this device, the composed set is installed in Core
 * as any download is; otherwise Core already reflects it and is left alone.
 */
async function composeShortcutJournal(
	entry: SyncEntry | undefined,
	seen: number,
	isCurrent: () => boolean
): Promise<void> {
	const key = ownKeybindingsKey();
	const remote = entry && !entry.deleted ? entry.value : null;
	const own = JSON.stringify(
		applyShortcutDelta(parseOverrides(remote), readShortcutJournal())
	);
	if (entry && entry.updatedAt > seen) {
		await writeKeybindings(own);
		if (!isCurrent()) {
			return;
		}
	}
	writeCachedValue(key, own);
	writeShortcutJournal(null);
	// The edits were made after the set they are composed onto.
	markLocalChange(
		key,
		Math.max(localTimestamp(key), (entry?.updatedAt ?? 0) + 1)
	);
	addDirty(key);
}

/**
 * Write shortcut overrides that arrived from another machine of the same OS.
 * Goes through `setKeybindings` rather than touching storage, so Core and every
 * open window get the change through the path they already listen on. The
 * editors are told even when the cycle retired meanwhile: Core changed either
 * way, and an editor left on the old set would show shortcuts not in effect.
 */
async function writeKeybindings(value: string | null): Promise<void> {
	const overrides: Overrides = value ? JSON.parse(value) : {};
	await setKeybindings(activeTarget(), overrides);
	window.dispatchEvent(
		new CustomEvent(KEYBINDINGS_EVENT, { detail: overrides })
	);
}

// ── Local <-> wire ───────────────────────────────────────────────────────────

/** The wire key for this machine's shortcuts. */
function ownKeybindingsKey(): string {
	return keybindingsKey(currentPlatform());
}

/** Whether a wire key may be written on THIS machine. */
function acceptsKey(key: string): boolean {
	if (isKeybindingsKey(key)) {
		// Only the slot for this OS. A Mac must never apply Windows chords.
		return platformOfKeybindingsKey(key) === currentPlatform();
	}
	return isSyncableKey(key);
}

/**
 * A synced key's current local value, WITHOUT awaiting anything.
 *
 * Every allowlisted key is a plain storage read; the shortcut slot is served
 * from the value cache. This is the only form the close-time flush can use, so
 * it is also the form the normal push uses — one code path, so the flush is not
 * a second, less-tested one.
 */
function readValueSync(key: string): string | null {
	if (isKeybindingsKey(key)) {
		return readCachedValue(key);
	}
	return readLocal(key);
}

/** Apply a remote value locally. */
async function writeValue(
	key: string,
	value: string | null,
	updatedAt: number,
	isCurrent: () => boolean
): Promise<void> {
	if (!isCurrent()) {
		return;
	}
	if (isKeybindingsKey(key)) {
		await writeKeybindings(value);
		if (!isCurrent()) {
			return;
		}
		// The account's own set; a deleted entry is a known empty set.
		writeCachedValue(key, value ?? "{}");
		markLocalChange(key, updatedAt);
		return;
	}
	applyRemote(key, value, updatedAt);
}

/** Build the push payload for the dirty set. Synchronous — see `readValueSync`. */
function collectDirty(): SyncEntry[] {
	const entries: SyncEntry[] = [];
	const unresolvedKeys = new Set(conflicts.map((conflict) => conflict.key));
	for (const key of dirty) {
		// A conflict under the default "ask" policy must stay local until the
		// user chooses a side. Sending it now would disclose the local value and
		// rely on the server rejecting it as stale; more importantly, another
		// policy/server behavior could apply it before that decision.
		if (unresolvedKeys.has(key)) {
			continue;
		}
		// Until the owner's own shortcut set is known, its edits are only
		// changes; sending them alone would replace the account's whole set.
		if (key === ownKeybindingsKey() && !shortcutBaseKnown()) {
			continue;
		}
		const value = readValueSync(key);
		entries.push({
			key,
			value,
			updatedAt: localTimestamp(key) || Date.now(),
			deleted: value === null,
		});
	}
	return entries;
}

// Delivery acknowledgement is per key; a newer unrelated pull cursor must
// not strand an unacknowledged local setting after the document restarts.
// Shortcuts use Core's physical scope/cache and are deliberately excluded.
function readPendingLocal(): Record<string, number> {
	try {
		const raw = readOwnedString(PENDING_LOCAL_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const pending: Record<string, number> = {};
		for (const [key, at] of Object.entries(parsed)) {
			if (
				acceptsKey(key) &&
				!isKeybindingsKey(key) &&
				typeof at === "number" &&
				Number.isFinite(at) &&
				at > 0
			) {
				pending[key] = at;
			}
		}
		return pending;
	} catch {
		return {};
	}
}

function persistPendingLocal(cleared?: string): void {
	// The journal is shared by every window, and a sibling's edit reaches this
	// window only as a `storage` event that is not copied into `dirty`. Keep a
	// sibling's entry while its stamp is still the current one, so this write
	// does not drop a change that window has yet to push.
	const pending: Record<string, number> = {};
	for (const [key, at] of Object.entries(readPendingLocal())) {
		if (key !== cleared && localTimestamp(key) === at) {
			pending[key] = at;
		}
	}
	for (const key of dirty) {
		if (!isKeybindingsKey(key)) {
			pending[key] = localTimestamp(key);
		}
	}
	writeOwnedString(PENDING_LOCAL_KEY, JSON.stringify(pending));
}

function addDirty(key: string): void {
	dirty.add(key);
	persistPendingLocal();
}

function clearDirty(key: string): void {
	dirty.delete(key);
	persistPendingLocal(key);
}

/**
 * Rebuild the pending set from what is on disk.
 *
 * The dirty set is in-memory, so a quit — clean or not — between a change and
 * the debounce firing would otherwise strand that change forever: nothing would
 * push it, and the pull path correctly declines to overwrite it, so it would sit
 * local-only until the user happened to touch the same setting again. The
 * Legacy timestamps newer than the pull cursor still seed pending changes.
 * A separate per-key journal retains unacknowledged ordinary settings even
 * when an unrelated remote setting advanced that cursor.
 */
function seedDirtyFromDisk(): void {
	const pending = readPendingLocal();
	const seen = cursor();
	// After a Core scope change the shortcut slot's stamp is that scope's own
	// pending edit (restored with it) or 0, not a time to compare to the cursor.
	const shortcutScopeChanged = fullPullRequested();
	for (const [key, at] of Object.entries(allLocalTimestamps())) {
		if (
			acceptsKey(key) &&
			at !== null &&
			(at > seen ||
				pending[key] === at ||
				(shortcutScopeChanged && isKeybindingsKey(key) && at > 0))
		) {
			dirty.add(key);
		}
	}
	persistPendingLocal();
}

// ── The sync cycle ───────────────────────────────────────────────────────────

/**
 * Apply one remote entry, or record a conflict.
 *
 * The conflict test is deliberately narrow: a key is only contested when THIS
 * machine has an unpushed change to it AND the values actually differ. A key the
 * user never touched here is not a conflict, it is just news.
 */
async function applyOrConflict(
	entry: SyncEntry,
	isCurrent: () => boolean
): Promise<boolean> {
	if (!isCurrent()) {
		return false;
	}
	if (!acceptsKey(entry.key)) {
		return false;
	}
	const local = readValueSync(entry.key);
	if (local === (entry.deleted ? null : entry.value)) {
		// Already agrees — adopt the timestamp so it stops looking pending.
		markLocalChange(entry.key, entry.updatedAt);
		clearDirty(entry.key);
		return false;
	}
	const localAt = localTimestamp(entry.key);
	if (
		!dirty.has(entry.key) &&
		localAt > 0 &&
		readPendingLocal()[entry.key] === localAt
	) {
		// A sibling window's edit that it has not pushed yet: its `storage` event
		// never marks the key dirty here, but the shared journal still holds it at
		// the current stamp. Adopt it (without re-stamping) so this remote value
		// is weighed against that edit under the conflict policy, not applied
		// over it as plain news.
		dirty.add(entry.key);
	}
	const accepted = acceptedLocalSnapshots.get(entry.key);
	if (
		dirty.has(entry.key) &&
		accepted &&
		localAt > accepted.updatedAt &&
		entry.updatedAt === accepted.updatedAt &&
		entry.value === accepted.value &&
		(entry.deleted === true) === (accepted.deleted === true)
	) {
		// A newer local edit is not competing with our own older accepted value.
		return false;
	}
	const contested = dirty.has(entry.key) && localAt > 0;
	if (contested) {
		const policy = getConflictPolicy();
		if (policy === "upload") {
			// The server rejects an older timestamp even when the user chose
			// this machine as authoritative. Make the chosen value actually win.
			markLocalChange(entry.key, Math.max(Date.now(), entry.updatedAt + 1));
			return false;
		}
		if (policy === "ask") {
			conflicts = [
				...conflicts.filter((c) => c.key !== entry.key),
				{
					key: entry.key,
					local,
					localAt,
					remote: entry.deleted ? null : entry.value,
					remoteAt: entry.updatedAt,
				},
			];
			return true;
		}
		// policy === "download" falls through to apply.
	}
	if (entry.updatedAt <= localAt) {
		// Ours is newer. This holds under `download` too: "always take the cloud
		// copy" means take the NEWER one, not take an older one — a policy that
		// walked a setting backwards in time would be indistinguishable from data
		// loss. The next push carries ours up instead.
		return false;
	}
	await writeValue(
		entry.key,
		entry.deleted ? null : entry.value,
		entry.updatedAt,
		isCurrent
	);
	if (!isCurrent()) {
		return false;
	}
	clearDirty(entry.key);
	return false;
}

/** Resolve one conflict the user has decided on. */
export async function resolveConflict(
	key: string,
	choice: "local" | "remote"
): Promise<void> {
	const conflict = conflicts.find((c) => c.key === key);
	if (!conflict) {
		return;
	}
	const isCurrent = currentCycle();
	if (choice === "remote") {
		try {
			await writeValue(key, conflict.remote, conflict.remoteAt, isCurrent);
		} catch {
			if (isCurrent()) {
				status = "offline";
				notify();
			}
			return;
		}
		if (!isCurrent()) {
			return;
		}
		clearDirty(key);
	} else {
		// Keep this machine's value, but stamp it NEWER than the remote so the
		// next push actually wins rather than being rejected again.
		markLocalChange(key, Math.max(Date.now(), conflict.remoteAt + 1));
		addDirty(key);
	}
	conflicts = conflicts.filter((c) => c.key !== key);
	if (conflicts.length === 0) {
		status = "idle";
	}
	notify();
	if (choice === "local") {
		void syncNow();
	}
}

/** Resolve every outstanding conflict the same way. */
export async function resolveAllConflicts(
	choice: "local" | "remote"
): Promise<void> {
	for (const conflict of conflicts.slice()) {
		await resolveConflict(conflict.key, choice);
	}
}

/**
 * One full cycle: pull what changed, apply or flag it, then push what this
 * machine owes. Pull first so a push that is about to be rejected as stale is
 * caught as a conflict here rather than as a silent no-op on the server.
 */
export async function syncNow(): Promise<void> {
	// One cycle at a time. Two overlapping cycles both read `dirty` and both
	// push; the second one's `applied` list then clears keys the first had
	// already handled, and a change that arrived in between is dropped.
	if (!isSyncEnabled()) {
		return;
	}
	if (inFlight) {
		// A fresh opt-in/restart request must survive the retired request's
		// settlement. One flag coalesces requests; errors never request a retry.
		resumeRequested = true;
		status = "syncing";
		notify();
		return;
	}
	inFlight = true;
	status = "syncing";
	notify();
	const isCurrent = currentCycle();
	const identity = activeSyncIdentity();
	if (!identity) {
		status = "idle";
		inFlight = false;
		notify();
		return;
	}
	try {
		await runSyncCycle(identity, isCurrent);
	} catch {
		if (isCurrent()) {
			status = "offline";
			notify();
		}
	} finally {
		inFlight = false;
		if (resumeRequested) {
			resumeRequested = false;
			if (isSyncEnabled()) {
				void syncNow();
			}
		}
	}
}

async function runSyncCycle(
	identity: SyncIdentity,
	isCurrent: () => boolean
): Promise<void> {
	// The shortcut slot is pushed from the owner's own set only, never from
	// the node-wide Core set. While this device does not know that set, edits
	// waiting for it make the pull start at the beginning of the account's
	// document to learn it; with none waiting, a later download teaches it.
	const shortcutKey = ownKeybindingsKey();
	const shortcutBaseUnknown = !shortcutBaseKnown();
	const learnShortcutBase =
		shortcutBaseUnknown && Object.keys(readShortcutJournal()).length > 0;
	const fullPull = fullPullRequested();
	// After a Core scope change everything is news to the new node's Core.
	const seen = fullPull ? 0 : cursor();
	const pulled = await pullSettings(learnShortcutBase ? 0 : seen, identity);
	if (!isCurrent()) {
		return;
	}
	if (!pulled) {
		status = "offline";
		notify();
		return;
	}
	if (shortcutBaseUnknown && !learnShortcutBase) {
		// Nothing of the owner's is waiting; a stamp left by a dropped set is not
		// a pending edit, so a newer download applies as news.
		clearDirty(shortcutKey);
	}
	let contested = false;
	let shortcutEntry: SyncEntry | undefined;
	for (const entry of pulled.entries) {
		if (learnShortcutBase && entry.key === shortcutKey) {
			shortcutEntry = entry;
			continue;
		}
		contested = (await applyOrConflict(entry, isCurrent)) || contested;
	}
	if (!isCurrent()) {
		return;
	}
	if (learnShortcutBase) {
		await composeShortcutJournal(shortcutEntry, seen, isCurrent);
		if (!isCurrent()) {
			return;
		}
	}
	setCursor(pulled.updatedAt);
	if (fullPull) {
		setFullPullRequested(false);
	}
	const entries = collectDirty();
	if (entries.length > 0) {
		const pushed = await pushSettings(entries, identity);
		if (!isCurrent()) {
			return;
		}
		if (pushed) {
			// `unchanged` keys are already stored exactly as sent: this machine's
			// earlier push, or a value it pulled. The commit-time cursor can sit
			// behind such an edit time when a clock runs fast, so
			// `seedDirtyFromDisk` re-marks the key after a restart; it already
			// agrees and must not stay pending forever. An entry in no list (dropped
			// as invalid, or a different value at the same edit time) stays pending.
			const acknowledged = [...pushed.applied, ...(pushed.unchanged ?? [])];
			for (const key of acknowledged) {
				const sent = entries.find((entry) => entry.key === key);
				if (sent && !isKeybindingsKey(key)) {
					acceptedLocalSnapshots.set(key, sent);
				}
				if (
					sent &&
					localTimestamp(key) === sent.updatedAt &&
					readValueSync(key) === sent.value
				) {
					clearDirty(key);
				}
			}
			// Advance past this push only when no other machine committed between
			// this cycle's pull and push. Otherwise the cursor would jump over
			// that commit and this machine would never pull it; leaving the cursor
			// at the pull re-delivers this machine's own entries, which
			// `applyOrConflict` already treats as agreeing.
			if (pushed.revision === pulled.revision + 1) {
				setCursor(pushed.updatedAt);
			}
			// Anything the server refused as stale is, by definition, contested:
			// this machine changed it and so did another one.
			for (const rejection of pushed.rejected) {
				contested = (await applyOrConflict(rejection, isCurrent)) || contested;
			}
		} else {
			status = "offline";
			notify();
			return;
		}
	}

	if (!isCurrent()) {
		return;
	}
	if (getPendingCount() === 0) {
		writeOwnedString(LAST_SYNC_KEY, String(Date.now()));
	}
	status = contested || conflicts.length > 0 ? "conflict" : "idle";
	notify();
}

/** Restart the debounce. Every new change pushes the upload further out. */
function scheduleUpload(): void {
	if (timer) {
		clearTimeout(timer);
	}
	timer = setTimeout(() => {
		timer = null;
		void syncNow();
	}, DEBOUNCE_MS);
	notify();
}

/** Push whatever is pending right now, without waiting for the debounce. */
export async function syncPendingNow(): Promise<void> {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	await syncNow();
}

// Scope ownership survives engine cleanup. A node selected while stopped
// must not inherit a saved-value cache from the previous node on restart.
function updateShortcutScope(): void {
	const target = activeTarget();
	const previous = shortcutTarget;
	if (!previous) {
		shortcutTarget = target;
		return;
	}
	if (
		target.url === previous.url &&
		target.token === previous.token &&
		target.userJwt === previous.userJwt
	) {
		return;
	}
	const previousUri = shortcutResource(previous);
	const nextUri = shortcutResource(target);
	if (previousUri !== nextUri) {
		const key = ownKeybindingsKey();
		if (dirty.has(key) && previousUri !== null) {
			pendingShortcutScopes.set(previousUri, {
				value: readCachedValue(key),
				at: localTimestamp(key),
				journal: readShortcutJournal(),
			});
		}
		const pending =
			nextUri === null ? undefined : pendingShortcutScopes.get(nextUri);
		if (nextUri !== null) {
			pendingShortcutScopes.delete(nextUri);
		}
		writeCachedValue(key, pending?.value ?? null);
		writeShortcutJournal(pending?.journal ?? null);
		markLocalChange(key, pending?.at ?? 0);
		if (pending) {
			addDirty(key);
		} else {
			clearDirty(key);
		}
		conflicts = conflicts.filter((conflict) => !isKeybindingsKey(conflict.key));
		setFullPullRequested(true);
	}
	shortcutTarget = target;
	resumeRequested = false;
	cycleGeneration++;
	status = "idle";
	notify();
}

function transitionSettingsOwner(nextOwner: string | null): void {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	resumeRequested = false;
	cycleGeneration++;
	dirty.clear();
	acceptedLocalSnapshots.clear();
	conflicts = [];
	pendingShortcutScopes.clear();
	// Leaving no owner (the engine started before the vault resolved an account)
	// claims the visible values only under the same rule as a cold start: they
	// were never attributed to another account on this device.
	const claimVisible =
		getSettingsOwner() === null && visibleSettingsClaim(nextOwner);
	activateEngineOwner(nextOwner, claimVisible);
	seedDirtyFromDisk();
	status = "idle";
	notify();
}

/**
 * The same session resolved to its real account id: a legacy single-token
 * install runs under a placeholder id until its profile loads. The bearer is
 * unchanged, so the loaded settings, pending work and pull cursor are that
 * account's and move with it instead of being set aside.
 */
function renameEngineOwner(previousOwner: string, nextOwner: string): void {
	for (const key of [
		CURSOR_KEY,
		LAST_SYNC_KEY,
		PENDING_LOCAL_KEY,
		FULL_PULL_KEY,
		SHORTCUT_CAPTURE_KEY,
		SHORTCUT_JOURNAL_KEY,
	]) {
		const from = scopedEngineKey(key, previousOwner);
		const value = readString(from);
		if (value !== null) {
			writeString(scopedEngineKey(key, nextOwner), value);
		}
		try {
			localStorage.removeItem(from);
		} catch {
			// Best-effort: a stale placeholder slot is never read again.
		}
	}
	renameSettingsOwner(previousOwner, nextOwner);
	// Requests captured for the placeholder identity retire; the work is kept.
	cycleGeneration++;
	if (dirty.size > 0 && isSyncEnabled()) {
		scheduleUpload();
	}
	notify();
}

/**
 * Start the engine. Idempotent, and safe to call when sync is disabled — the
 * observer still installs (so timestamps stay accurate for the moment sync is
 * turned on) while nothing is uploaded.
 */
export function startSettingsSync(): () => void {
	if (started) {
		return () => undefined;
	}
	started = true;
	installSettingsObserver();
	try {
		localStorage.removeItem(RETIRED_SHORTCUT_ATTRIBUTION_KEY);
	} catch {
		// Best-effort: nothing reads the retired record.
	}
	const initialOwner = getVerifiedActiveUserId();
	activateEngineOwner(initialOwner, visibleSettingsClaim(initialOwner));
	updateShortcutScope();
	seedDirtyFromDisk();

	const unsubscribeNode = useNodeStore.subscribe(updateShortcutScope);
	const unsubscribeIdentityTransition = onBeforeAccountIdentityChange(
		({ from, to }) => {
			const owner = getSettingsOwner();
			if (owner === to.userId) {
				// A same-account token refresh still retires captured requests, but it
				// must not discard that account's pending settings.
				cycleGeneration++;
				return;
			}
			if (
				owner !== null &&
				to.userId !== null &&
				from.userId === owner &&
				from.token !== null &&
				from.token === to.token
			) {
				renameEngineOwner(owner, to.userId);
				return;
			}
			transitionSettingsOwner(to.userId);
		}
	);
	// Only a bearer that is the active vault account's own token owns settings.
	// A bearer written without a vault row (the offline sign-in fallback) leaves
	// no owner, so sync stays suspended until the vault resolves the account
	// rather than acting for the previous one. Covers another window changing
	// the sealed vault and legacy/direct TOKEN_KEY writers that bypass the
	// vault hook.
	const handleBearerChange = () => {
		const activeOwner = getVerifiedActiveUserId();
		if (getSettingsOwner() === activeOwner) {
			cycleGeneration++;
		} else {
			transitionSettingsOwner(activeOwner);
		}
	};
	// The vault is sealed and held in memory now; the legacy storage-key path
	// still covers hosts that only have the plaintext key (tests, the harness).
	const unsubscribeVaultIdentity = onActiveTokenChange(handleBearerChange);
	const unsubscribeIdentity = onStorageKeyChange((key) => {
		if (key === TOKEN_KEY) {
			handleBearerChange();
		}
	});

	const unsubscribe = onSettingsChange((key) => {
		if (!isSyncEnabled()) {
			return;
		}
		addDirty(key);
		scheduleUpload();
	});

	const onShortcutEdit = (event: Event) => {
		const edit = shortcutEditSchema.safeParse(
			event instanceof CustomEvent ? event.detail : undefined
		);
		// The editor's storage announces the edit when the user makes it, before
		// Core's write is awaited, so the owner read here is the account that was
		// active then, not one a switch made active while the write was in flight.
		// An edit made while no account's settings are loaded here (or after
		// another window moved them to another account) belongs to no one.
		const owner = ownsVisibleSettings() ? getSettingsOwner() : null;
		if (!edit.success || owner === null) {
			return;
		}
		const delta = shortcutDelta(edit.data.before, edit.data.after);
		if (Object.keys(delta).length === 0) {
			return;
		}
		const key = ownKeybindingsKey();
		// Only the overrides this edit changed join the owner's own set; ones the
		// editor merely carried (another account's) are never adopted. Captured
		// with sync off too, so turning it on uploads the owner's edits.
		if (shortcutBaseKnown()) {
			writeCachedValue(
				key,
				JSON.stringify(
					applyShortcutDelta(parseOverrides(readCachedValue(key)), delta)
				)
			);
		} else {
			const journal = readShortcutJournal();
			writeShortcutJournal({ ...journal, ...delta });
		}
		markLocalChange(key);
		if (!isSyncEnabled()) {
			return;
		}
		addDirty(key);
		scheduleUpload();
	};
	window.addEventListener(KEYBINDINGS_EDIT_EVENT, onShortcutEdit);

	// A change made moments before quitting is the one people notice missing.
	const onHide = () => {
		if (!isSyncEnabled() || dirty.size === 0) {
			return;
		}
		// Capture first: the entries are collected for exactly this owner, and
		// flushSettings refuses the identity if the live session moved on.
		const identity = activeSyncIdentity();
		if (!identity) {
			return;
		}
		flushSettings(collectDirty(), identity);
	};
	window.addEventListener("pagehide", onHide);
	const onVisibility = () => {
		if (document.visibilityState === "hidden") {
			onHide();
		} else {
			void syncNow();
		}
	};
	document.addEventListener("visibilitychange", onVisibility);

	poller = setInterval(() => void syncNow(), POLL_MS);
	void syncNow();

	return () => {
		acceptedLocalSnapshots.clear();
		dirty.clear();
		conflicts = [];
		releaseSettingsOwner();
		started = false;
		resumeRequested = false;
		cycleGeneration++;
		status = "idle";
		unsubscribe();
		unsubscribeVaultIdentity();
		unsubscribeIdentity();
		unsubscribeIdentityTransition();
		unsubscribeNode();
		document.removeEventListener("visibilitychange", onVisibility);
		notify();
		window.removeEventListener(KEYBINDINGS_EDIT_EVENT, onShortcutEdit);
		window.removeEventListener("pagehide", onHide);
		if (poller) {
			clearInterval(poller);
			poller = null;
		}
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
}
