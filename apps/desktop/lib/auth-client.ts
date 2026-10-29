import { ryuOrganizationClient } from "@ryu/auth/organization-client";
import { configureSettingsApi } from "@ryu/settings";
import {
	anonymousClient,
	inferAdditionalFields,
	magicLinkClient,
	twoFactorClient,
	usernameClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { z } from "zod";
import { getStartupDefaultAccountId } from "@/src/lib/startup-selection.ts";
import {
	invokeWhenReady,
	isNoDesktopBackend,
	isTauriReady,
	listenWhenReady,
	TauriUnavailableError,
	withTauri,
} from "@/src/lib/tauri-ready.ts";
import {
	type AccountIdentity,
	announceAccountIdentityChange,
	announceAccountStateRemoved,
	trackAccountWrite,
} from "./account-transition.ts";
import { BACKEND_URL, FRONTEND_URL } from "./app-urls.ts";
import { AUTH_CORE_URL, DEFAULT_CORE_URL } from "./core-url.ts";
import { log } from "./log.ts";
import { registerVaultOwnerSource } from "./session-owner.ts";
import { getLocalNodeToken } from "./tauri-bridge.ts";

export {
	type AccountIdentity,
	type AccountIdentityTransition,
	onBeforeAccountIdentityChange,
} from "./account-transition.ts";
export { getVerifiedActiveUserId } from "./session-owner.ts";
export { BACKEND_URL, FRONTEND_URL };
// Legacy plaintext locations of the multi-account vault. Tokens are no longer
// written to either: the vault lives sealed in the desktop's `auth-vault` secret
// slot (`enc:v1:`, a key held in the OS keychain; see `desktop_seal.rs`) and in
// memory for synchronous reads. These keys are read once to migrate an existing
// install, then removed. A host without the native slot (unit tests, the plain
// browser story harness) still reads them, read-only.
export const TOKEN_KEY = "ryu_session_token";
const ACCOUNTS_KEY = "ryu_accounts";
const ACTIVE_USER_KEY = "ryu_active_user_id";
const WAITLIST_CACHE_KEY = "ryu_waitlist_approved";
const BROWSER_NODE_KEY_PREFIX = "ryu_nodes:";
const BROWSER_NODE_TOKENS_KEY_PREFIX = "ryu_node_tokens:";
const LEGACY_BROWSER_NODE_KEY = "ryu_nodes";
const SETTINGS_VISIBLE_OWNER_KEY = "ryu:settings-sync-visible-owner";
const ACCOUNT_SCOPED_SETTING_PREFIXES = [
	"ryu:settings-sync-values:",
	"ryu:settings-sync-meta:",
	"ryu:settings-sync-value-cache:",
	"ryu:settings-sync-cursor:",
	"ryu:settings-sync-last:",
	"ryu:settings-sync-pending-local:",
	"ryu:settings-sync-full-pull:",
	"ryu:settings-sync-keybindings-capture:",
	"ryu:settings-sync-keybindings-journal:",
] as const;
/** The native secret slot that holds the sealed vault. */
const AUTH_VAULT_SLOT = "auth-vault";
/** Native event every window receives after a secret slot changes. */
const SECRET_CHANGED_EVENT = "desktop-secret-changed";
const LEGACY_STORE_FILE = "auth.bin";
const LEGACY_STORE_KEYS = ["accounts", "activeUserId", "token"] as const;

/**
 * A signed-in account. Tokens NEVER leave the device: this shape (including the
 * raw bearer token) is stored only in the sealed local vault. UI surfaces should
 * render the safe fields (userId, email, name, image) plus an `active` flag.
 */
export interface StoredAccount {
	email: string;
	image: string | null;
	isAnonymous?: boolean;
	name: string | null;
	token: string;
	userId: string;
}

export interface VaultState {
	accounts: StoredAccount[];
	activeUserId: string | null;
}

/**
 * Where the vault persists. `unknown` until the first native call answers;
 * `native` when the sealed slot exists (desktop, or the webapp's sealing shim);
 * `unavailable` outside any host that provides it.
 */
type VaultBackend = "native" | "unavailable" | "unknown";

let backend: VaultBackend = "unknown";
let vault: VaultState = { accounts: [], activeUserId: null };
/**
 * True while the sealed vault exists but could not be read (a locked keychain,
 * the Secret Service not up yet). Nothing may overwrite the slot until a read
 * succeeds, or a sign-in would seal a vault holding only the new account over
 * the accounts that were never loaded.
 */
let vaultUnread = false;
const tokenEvents = new EventTarget();
const TOKEN_CHANGE_EVENT = "active-token-change";

const storedAccountsSchema = z.array(
	z.looseObject({
		email: z.string(),
		image: z.string().nullable(),
		isAnonymous: z.boolean().optional(),
		name: z.string().nullable(),
		token: z.string(),
		userId: z.string(),
	})
);
const vaultStateSchema = z.object({
	accounts: storedAccountsSchema,
	activeUserId: z.string().nullable(),
});
const sessionProfileSchema = z.object({
	user: z.object({
		id: z.string().min(1),
		email: z.string().nullish(),
		isAnonymous: z.boolean().optional(),
		name: z.string().nullish(),
		image: z.string().nullish(),
	}),
});

function readLegacyItem(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function removeLegacyItems(): void {
	try {
		for (const key of [TOKEN_KEY, ACCOUNTS_KEY, ACTIVE_USER_KEY]) {
			globalThis.localStorage?.removeItem(key);
		}
	} catch {
		// Storage unavailable: nothing to remove.
	}
}

function readLegacyAccounts(): StoredAccount[] {
	try {
		const raw = readLegacyItem(ACCOUNTS_KEY);
		if (!raw) {
			return [];
		}
		return storedAccountsSchema.parse(JSON.parse(raw));
	} catch {
		return [];
	}
}

/** Read-only legacy plaintext fallback, never used once the sealed slot exists. */
function legacyFallbackAllowed(): boolean {
	return backend !== "native" && vault.accounts.length === 0;
}

function readAccounts(): StoredAccount[] {
	if (legacyFallbackAllowed()) {
		return readLegacyAccounts();
	}
	return vault.accounts.map((account) => ({ ...account }));
}

function readActiveUserId(): string | null {
	if (legacyFallbackAllowed()) {
		return readLegacyItem(ACTIVE_USER_KEY);
	}
	return vault.activeUserId;
}

function activeAccountOf(state: VaultState): StoredAccount | null {
	return (
		state.accounts.find((account) => account.userId === state.activeUserId) ??
		state.accounts[0] ??
		null
	);
}

function getTokenSync(): string | null {
	const active = activeAccountOf(vault);
	if (active) {
		return active.token;
	}
	return legacyFallbackAllowed() ? readLegacyItem(TOKEN_KEY) : null;
}

function getTokenForAuth(): string | undefined {
	return getTokenSync() ?? undefined;
}

/**
 * Subscribe to changes of the active account's token (sign-in, sign-out,
 * account switch, or another window changing the vault). Replaces the
 * cross-window `storage` events the plaintext localStorage vault used to give.
 */
export function isVaultLocked(): boolean {
	return vaultUnread;
}

/** Union of the sealed accounts and `state`; `state` wins on a shared userId. */
function mergeVaults(sealed: VaultState, state: VaultState): VaultState {
	const known = new Set(state.accounts.map((account) => account.userId));
	return {
		accounts: [
			...state.accounts,
			...sealed.accounts.filter((account) => !known.has(account.userId)),
		],
		activeUserId: state.activeUserId ?? sealed.activeUserId,
	};
}

export function onActiveTokenChange(listener: () => void): () => void {
	const handler = () => listener();
	tokenEvents.addEventListener(TOKEN_CHANGE_EVENT, handler);
	return () => tokenEvents.removeEventListener(TOKEN_CHANGE_EVENT, handler);
}

function setVault(next: VaultState): void {
	const beforeToken = getTokenSync();
	const beforeUser = getActiveUserId();
	vault = {
		accounts: next.accounts.map((account) => ({ ...account })),
		activeUserId: next.activeUserId,
	};
	// A placeholder account (userId === token) is swapped for the real profile
	// without changing the token, so the active user id counts too.
	if (getTokenSync() !== beforeToken || getActiveUserId() !== beforeUser) {
		tokenEvents.dispatchEvent(new Event(TOKEN_CHANGE_EVENT));
	}
}

async function readNativeVault(): Promise<VaultState | null> {
	const raw = await invokeWhenReady<string | null | undefined>(
		"desktop_secret_get",
		{ name: AUTH_VAULT_SLOT }
	);
	if (raw === undefined) {
		// The slot answers `null` when empty. `undefined` is what a host that does
		// not implement the command resolves (a shim's unknown-command fallback).
		throw new TauriUnavailableError("desktop_secret_get");
	}
	backend = "native";
	if (!raw) {
		return null;
	}
	return vaultStateSchema.parse(JSON.parse(raw));
}

/**
 * Persist the vault to the sealed native slot. Fails closed: when the slot
 * cannot seal (no key), the error propagates and nothing is written in
 * plaintext. Outside a host with the slot the vault stays in memory only.
 *
 * Resolves `true` only when the sealed slot confirmed the write. `false` means
 * the vault is held in memory only (no slot here, or the slot reported it could
 * not seal, as the webapp shim does when browser sealing fails), so a caller
 * must not discard any other copy on the strength of this write.
 */
async function writeNativeVault(requested: VaultState): Promise<boolean> {
	if (backend === "unavailable") {
		return false;
	}
	let state = requested;
	if (vaultUnread) {
		// The sealed vault was never read: merge it in before writing, and keep
		// the new state in memory only while it still cannot be read.
		try {
			const sealed = await readNativeVault();
			if (sealed) {
				state = mergeVaults(sealed, requested);
				setVault(state);
			}
			vaultUnread = false;
		} catch {
			return false;
		}
	}
	try {
		if (state.accounts.length === 0) {
			await invokeWhenReady("desktop_secret_delete", { name: AUTH_VAULT_SLOT });
		} else {
			await invokeWhenReady("desktop_secret_set", {
				name: AUTH_VAULT_SLOT,
				value: JSON.stringify(state),
			});
		}
		backend = "native";
		return true;
	} catch (error) {
		if (!isNoDesktopBackend(error)) {
			throw error;
		}
		backend = "unavailable";
		return false;
	}
}

let storePromise: Promise<import("@tauri-apps/plugin-store").Store> | null =
	null;

/** The legacy plaintext `auth.bin` plugin store, opened only to migrate it. */
function getLegacyAuthStore(): Promise<
	import("@tauri-apps/plugin-store").Store
> {
	if (!storePromise) {
		storePromise = (async () => {
			const { load } = await import("@tauri-apps/plugin-store");
			const store = await withTauri(() => load(LEGACY_STORE_FILE));
			if (!store) {
				throw new TauriUnavailableError(`plugin-store:${LEGACY_STORE_FILE}`);
			}
			return store;
		})();
		// Do not memoize a failure: a later call retries once the bridge exists.
		storePromise.catch(() => {
			storePromise = null;
		});
	}
	return storePromise;
}

async function readLegacyStoreVault(): Promise<VaultState | null> {
	try {
		const store = await getLegacyAuthStore();
		const accounts = storedAccountsSchema.safeParse(
			await store.get("accounts")
		);
		if (accounts.success && accounts.data.length > 0) {
			const active = await store.get<string>("activeUserId");
			return {
				accounts: accounts.data,
				activeUserId: typeof active === "string" ? active : null,
			};
		}
		const token = await store.get<string>("token");
		return typeof token === "string" && token
			? { accounts: [placeholderAccount(token)], activeUserId: token }
			: null;
	} catch {
		return null;
	}
}

/** Remove every plaintext copy of the vault (localStorage and `auth.bin`). */
async function purgeLegacyVault(): Promise<void> {
	removeLegacyItems();
	try {
		const store = await getLegacyAuthStore();
		let removed = false;
		for (const key of LEGACY_STORE_KEYS) {
			removed = (await store.delete(key)) || removed;
		}
		if (removed) {
			await store.save();
		}
	} catch {
		// No plugin store here: nothing on disk to purge.
	}
}

function placeholderAccount(token: string): StoredAccount {
	// A legacy single-token install: the token stands in for the userId so it
	// works offline, then enrichLegacyAccount swaps in the real profile.
	return {
		token,
		userId: token,
		email: "",
		isAnonymous: false,
		name: null,
		image: null,
	};
}

/** All accounts currently in the local vault (includes the local-only token). */
export function listAccounts(): StoredAccount[] {
	return readAccounts();
}

/** The active account's userId, falling back to the first account if unset. */
export function getActiveUserId(): string | null {
	const accounts = readAccounts();
	const activeId = readActiveUserId();
	if (activeId && accounts.some((a) => a.userId === activeId)) {
		return activeId;
	}
	return accounts[0]?.userId ?? null;
}

/**
 * The active account's id for keying per-account local data (collaboration
 * snapshots), or null while the active account is a placeholder whose userId is
 * the bearer token. That id must never be stored: it is a credential, and it is
 * replaced by the real id once the profile loads.
 */
export function getActiveCollaborationAccountId(): string | null {
	const userId = getActiveUserId();
	if (userId === null) {
		return null;
	}
	const account = readAccounts().find((a) => a.userId === userId);
	return account && account.userId === account.token ? null : userId;
}

/**
 * The account an identity belongs to for keying per-account local state, or
 * null while it is a placeholder whose userId is the bearer token itself: that
 * id is a credential and must never be stored or used as a key.
 */
function ownerIdOf(identity: AccountIdentity): AccountIdentity {
	return identity.userId !== null && identity.userId === identity.token
		? { ...identity, userId: null }
		: identity;
}

function currentIdentity(): AccountIdentity {
	return ownerIdOf({ userId: getActiveUserId(), token: getTokenSync() });
}

/**
 * Announce an account transition before the vault changes, so a settings
 * engine (or any listener) can move the departing account's state aside.
 */
function announceIdentityChange(next: AccountIdentity): void {
	const to = ownerIdOf(next);
	const from = currentIdentity();
	if (from.userId === to.userId && from.token === to.token) {
		return;
	}
	announceAccountIdentityChange({ from, to });
	if (from.userId !== to.userId && to.userId === null) {
		// Leaving every verified account: if no settings engine is mounted to move
		// the visible settings aside, mark them unclaimable rather than letting
		// the next account adopt them. Written after the announcement, because a
		// mounted engine reads this record to learn whose values are visible and
		// saves them to that owner first. A switch to another account keeps the
		// record naming the current owner, so a later engine start can save the
		// visible values back to that owner before loading the new one.
		try {
			globalThis.localStorage?.setItem(
				SETTINGS_VISIBLE_OWNER_KEY,
				"unowned-transition"
			);
		} catch {
			// Storage unavailable: nothing was visible there.
		}
	}
}

function removeBrowserNodeRegistry(userId: string): void {
	try {
		const encoded = encodeURIComponent(userId);
		globalThis.localStorage?.removeItem(`${BROWSER_NODE_KEY_PREFIX}${encoded}`);
		globalThis.localStorage?.removeItem(
			`${BROWSER_NODE_TOKENS_KEY_PREFIX}${encoded}`
		);
		for (const prefix of ACCOUNT_SCOPED_SETTING_PREFIXES) {
			globalThis.localStorage?.removeItem(`${prefix}${encoded}`);
		}
	} catch {
		// Storage unavailable: nothing to remove.
	}
	announceAccountStateRemoved(userId);
}

/**
 * A legacy single-token install is migrated under a placeholder id until its
 * profile resolves. Nodes paired meanwhile were paired by that same session, so
 * they move to the resolved account rather than being stranded (never merged
 * over a registry the resolved account already owns).
 */
function adoptPlaceholderNodeRegistry(
	placeholderId: string,
	userId: string
): void {
	if (placeholderId === userId) {
		return;
	}
	try {
		const storage = globalThis.localStorage;
		if (!storage) {
			return;
		}
		for (const prefix of [
			BROWSER_NODE_KEY_PREFIX,
			BROWSER_NODE_TOKENS_KEY_PREFIX,
		]) {
			const from = `${prefix}${encodeURIComponent(placeholderId)}`;
			const to = `${prefix}${encodeURIComponent(userId)}`;
			const registry = storage.getItem(from);
			if (registry !== null && storage.getItem(to) === null) {
				storage.setItem(to, registry);
			}
			storage.removeItem(from);
		}
	} catch {
		// Storage unavailable: nothing to move.
	}
}

/**
 * The settings scope kept under a legacy placeholder id is the same session's,
 * so it becomes the resolved account's (never merged over a scope that account
 * already owns). A mounted settings engine re-keys its live scope itself while
 * the identity change is announced; this covers an engine that was not running.
 * The placeholder is the bearer itself, so no scope is ever created under it
 * any more: this only moves what an earlier build left.
 */
function adoptPlaceholderSettings(placeholderId: string, userId: string): void {
	if (placeholderId === userId) {
		return;
	}
	try {
		const storage = globalThis.localStorage;
		if (!storage) {
			return;
		}
		for (const prefix of ACCOUNT_SCOPED_SETTING_PREFIXES) {
			const from = `${prefix}${encodeURIComponent(placeholderId)}`;
			const to = `${prefix}${encodeURIComponent(userId)}`;
			const value = storage.getItem(from);
			if (value !== null && storage.getItem(to) === null) {
				storage.setItem(to, value);
			}
			storage.removeItem(from);
		}
		if (storage.getItem(SETTINGS_VISIBLE_OWNER_KEY) === placeholderId) {
			storage.setItem(SETTINGS_VISIBLE_OWNER_KEY, userId);
		}
	} catch {
		// Storage unavailable: nothing to move.
	}
}

function removeAllBrowserNodeRegistries(): void {
	try {
		const storage = globalThis.localStorage;
		if (!storage) {
			return;
		}
		storage.removeItem(LEGACY_BROWSER_NODE_KEY);
		const keys: string[] = [];
		for (let index = 0; index < storage.length; index += 1) {
			const key = storage.key(index);
			if (key === null) {
				continue;
			}
			if (
				key.startsWith(BROWSER_NODE_KEY_PREFIX) ||
				key.startsWith(BROWSER_NODE_TOKENS_KEY_PREFIX) ||
				ACCOUNT_SCOPED_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))
			) {
				keys.push(key);
			}
		}
		for (const key of keys) {
			storage.removeItem(key);
		}
	} catch {
		// Storage unavailable: nothing to remove.
	}
	announceAccountStateRemoved(null);
}

/**
 * The account whose bearer is live, or null (signed out, a switch in progress,
 * an unverified bearer, or a placeholder account whose id is the token). The
 * session-owner checks answer from the sealed in-memory vault through this.
 */
function verifiedActiveUserId(): string | null {
	const token = getTokenSync();
	if (!token) {
		return null;
	}
	const accounts = readAccounts();
	const activeId = readActiveUserId();
	const active = accounts.find((a) => a.userId === activeId) ?? accounts[0];
	if (!active || active.token !== token || active.userId === active.token) {
		return null;
	}
	return active.userId;
}

registerVaultOwnerSource({
	accountCount: () => readAccounts().length,
	verifiedActiveUserId,
});

// Persist the vault: memory first (synchronous readers see it at once), then
// the sealed native slot, which every other window reloads from. Resolves
// whether the sealed slot confirmed the write (see writeNativeVault).
async function persistVault(
	accounts: StoredAccount[],
	activeUserId: string | null
): Promise<boolean> {
	const active =
		accounts.find((a) => a.userId === activeUserId) ?? accounts[0] ?? null;
	const next: VaultState = {
		accounts,
		activeUserId: active?.userId ?? null,
	};
	announceIdentityChange({
		userId: next.activeUserId,
		token: active?.token ?? null,
	});
	setVault(next);
	// Registered in the announcing task, so a window reloading for the account
	// change waits for the durable vault to name the new account.
	return await trackAccountWrite(writeNativeVault(next));
}

// Resolve a raw bearer token to its account profile via the Better Auth bearer
// plugin. Never sends the token anywhere but the trusted backend.
async function fetchAccountProfile(token: string): Promise<{
	userId: string;
	email: string;
	isAnonymous: boolean;
	name: string | null;
	image: string | null;
}> {
	const res = await fetch(`${BACKEND_URL}/api/auth/get-session`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) {
		throw new Error("Failed to resolve account profile");
	}
	const { user } = sessionProfileSchema.parse(await res.json());
	return {
		userId: user.id,
		email: user.email ?? "",
		isAnonymous: user.isAnonymous === true,
		name: user.name ?? null,
		image: user.image ?? null,
	};
}

function clearWaitlistCache(): void {
	try {
		globalThis.localStorage?.removeItem(WAITLIST_CACHE_KEY);
	} catch {
		// Storage unavailable: nothing cached.
	}
}

/**
 * Add (or refresh) an account from a freshly issued bearer token and make it the
 * active one, KEEPING every other account in the vault. Fetches the profile so
 * the switcher can show a name/email/avatar.
 */
export async function addAccount(token: string): Promise<StoredAccount> {
	const profile = await fetchAccountProfile(token);
	const accounts = readAccounts();
	const account: StoredAccount = { token, ...profile };
	const idx = accounts.findIndex((a) => a.userId === profile.userId);
	if (idx >= 0) {
		accounts[idx] = account;
	} else {
		accounts.push(account);
	}
	// New active account: drop the per-account waitlist cache so it re-checks.
	clearWaitlistCache();
	await persistVault(accounts, profile.userId);
	return account;
}

/** Switch the active account. No-op if the userId is not in the vault. */
export async function switchAccount(userId: string): Promise<void> {
	const accounts = readAccounts();
	if (!accounts.some((a) => a.userId === userId)) {
		return;
	}
	clearWaitlistCache();
	await persistVault(accounts, userId);
}

/**
 * Remove one account from the vault. If it was active, fall back to another
 * account when present, otherwise leave the fully-logged-out state.
 */
export async function signOutAccount(userId: string): Promise<void> {
	const remaining = readAccounts().filter((a) => a.userId !== userId);
	const wasActive = getActiveUserId() === userId;
	const account = readAccounts().find((a) => a.userId === userId);
	if (wasActive && account?.isAnonymous) {
		await authClient.deleteAnonymousUser().catch(() => undefined);
	}
	if (wasActive) {
		clearWaitlistCache();
	}
	if (remaining.length === 0) {
		announceIdentityChange({ token: null, userId: null });
		// After the transition: listeners may persist the departing account's
		// state while moving it aside, and that copy must not survive sign-out.
		removeBrowserNodeRegistry(userId);
		removeLegacyItems();
		await persistVault([], null);
		return;
	}
	const nextActive = wasActive
		? remaining[0].userId
		: (readActiveUserId() ?? remaining[0].userId);
	const persisted = persistVault(remaining, nextActive);
	// persistVault announces the transition synchronously; remove the departing
	// account's browser-held state only after listeners have moved it aside.
	removeBrowserNodeRegistry(userId);
	await persisted;
}

export async function storeSessionToken(token: string): Promise<void> {
	try {
		await addAccount(token);
	} catch {
		// Profile fetch failed (offline / backend hiccup). Keep the user signed in
		// with a placeholder account; hydrate enriches it on a later launch.
		clearWaitlistCache();
		const accounts = readAccounts().filter((a) => a.token !== token);
		const placeholder = placeholderAccount(token);
		await persistVault([...accounts, placeholder], placeholder.userId);
		enrichLegacyAccount(token).catch(() => undefined);
	}
}

/**
 * The local Core's node bearer, which `/api/auth/logout` requires. Only sent
 * when the auth Core IS the local sidecar: a webapp `VITE_AUTH_CORE_URL` cloud
 * Core must never receive it. Null outside Tauri or when none is minted.
 */
async function localCoreBearer(): Promise<string | null> {
	if (AUTH_CORE_URL !== DEFAULT_CORE_URL || !isTauriReady()) {
		return null;
	}
	try {
		const { token } = await getLocalNodeToken();
		return token?.trim() || null;
	} catch {
		return null;
	}
}

/** Clear Core's on-disk auth vault so device login cannot resurrect a stale token. */
export async function clearCoreAuth(): Promise<void> {
	try {
		const bearer = await localCoreBearer();
		const response = await fetch(`${AUTH_CORE_URL}/api/auth/logout`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
			},
			body: JSON.stringify({ all: true }),
		});
		if (!response.ok) {
			log.warn(
				`[auth] Core logout returned HTTP ${response.status}; Core may still hold the previous account`
			);
		}
	} catch {
		// Core may be stopped; the desktop vault is still cleared below.
	}
}

export async function clearSessionToken(): Promise<void> {
	const activeAccount = readAccounts().find(
		(account) => account.userId === getActiveUserId()
	);
	if (activeAccount?.isAnonymous) {
		await authClient.deleteAnonymousUser().catch(() => undefined);
	}
	// Full sign-out: clear the entire vault (every account) and every legacy copy.
	// Drop the cached waitlist-approval so the next account is re-checked clean.
	announceIdentityChange({ token: null, userId: null });
	removeAllBrowserNodeRegistries();
	clearWaitlistCache();
	removeLegacyItems();
	await trackAccountWrite(
		(async () => {
			await persistVault([], null);
			await purgeLegacyVault();
			await clearCoreAuth();
		})()
	);
}

// Enrich a legacy single-token account (migrated with a placeholder id) with its
// real profile once the backend is reachable, replacing the placeholder in place.
async function enrichLegacyAccount(token: string): Promise<void> {
	const profile = await fetchAccountProfile(token);
	const accounts = readAccounts();
	const idx = accounts.findIndex((a) => a.token === token);
	if (idx < 0) {
		return;
	}
	const placeholderId = accounts[idx].userId;
	const wasActive = readActiveUserId() === placeholderId;
	adoptPlaceholderNodeRegistry(placeholderId, profile.userId);
	accounts[idx] = { token, ...profile };
	const nextActive = wasActive
		? profile.userId
		: (readActiveUserId() ?? profile.userId);
	const persisted = persistVault(accounts, nextActive);
	// After the synchronous announce, so a mounted engine re-keys first.
	adoptPlaceholderSettings(placeholderId, profile.userId);
	await persisted;
}

/** The plaintext vault an existing install left behind, if any. */
async function readLegacyVault(): Promise<VaultState | null> {
	const accounts = readLegacyAccounts();
	if (accounts.length > 0) {
		return { accounts, activeUserId: readLegacyItem(ACTIVE_USER_KEY) };
	}
	const fromStore = await readLegacyStoreVault();
	if (fromStore) {
		return fromStore;
	}
	const token = readLegacyItem(TOKEN_KEY);
	return token
		? { accounts: [placeholderAccount(token)], activeUserId: token }
		: null;
}

function hasPlaceholder(state: VaultState): StoredAccount | null {
	return (
		state.accounts.find((account) => account.userId === account.token) ?? null
	);
}

/**
 * Install a vault another window wrote. The change is announced first, like an
 * in-document switch, so settings and node state move off the previous account
 * before the active account changes under them.
 */
export function applyVaultFromOtherWindow(next: VaultState): void {
	const active = activeAccountOf(next);
	announceIdentityChange({
		userId: active?.userId ?? null,
		token: active?.token ?? null,
	});
	setVault(next);
}

/** Reload the vault from the sealed slot (another window changed it). */
async function reloadNativeVault(): Promise<void> {
	try {
		const sealed = await readNativeVault();
		if (vaultUnread) {
			// The first read failed: keep anything signed in since, and seal the
			// union.
			vaultUnread = false;
			const merged = sealed ? mergeVaults(sealed, vault) : vault;
			applyVaultFromOtherWindow(merged);
			if (merged.accounts.length > (sealed?.accounts.length ?? 0)) {
				await writeNativeVault(merged);
			}
			return;
		}
		applyVaultFromOtherWindow(sealed ?? { accounts: [], activeUserId: null });
	} catch {
		// Keep the current in-memory vault; the next change retries.
	}
}

let secretListenerRegistered = false;

/** Reload the vault whenever another window changes the sealed slot. */
function listenForVaultChanges(): void {
	if (secretListenerRegistered) {
		return;
	}
	secretListenerRegistered = true;
	void listenWhenReady<string>(SECRET_CHANGED_EVENT, (event) => {
		if (event.payload === AUTH_VAULT_SLOT) {
			void reloadNativeVault();
		}
	}).catch(() => {
		secretListenerRegistered = false;
	});
}

/** Retry the first read when the window regains focus, until it succeeds. */
function retryUnreadVaultOnFocus(): void {
	if (typeof window === "undefined") {
		return;
	}
	const retry = async () => {
		if (!vaultUnread) {
			window.removeEventListener("focus", retry);
			return;
		}
		await reloadNativeVault();
		if (!vaultUnread) {
			window.removeEventListener("focus", retry);
		}
	};
	window.addEventListener("focus", retry);
}

// On startup, load the sealed vault into memory, migrating a plaintext vault an
// older build left in localStorage or `auth.bin`, then apply the startup
// default account.
async function hydrateVault(): Promise<void> {
	let stored: VaultState | null = null;
	try {
		stored = await readNativeVault();
	} catch (error) {
		if (!isNoDesktopBackend(error)) {
			// The slot exists but could not be opened (no key, tampered file). Stay
			// signed out rather than fall back to any plaintext copy.
			backend = "native";
			vaultUnread = true;
			listenForVaultChanges();
			retryUnreadVaultOnFocus();
			throw error;
		}
		backend = "unavailable";
		return;
	}
	listenForVaultChanges();

	if (stored) {
		// A crash between seal and purge can leave a plaintext copy behind.
		void purgeLegacyVault();
		// A placeholder sealed by an earlier offline sign-in: swap in the profile.
		const sealedPlaceholder = hasPlaceholder(stored);
		if (sealedPlaceholder) {
			enrichLegacyAccount(sealedPlaceholder.token).catch(() => undefined);
		}
	} else {
		const legacy = await readLegacyVault();
		if (legacy) {
			// Seal first, purge only after the slot confirmed the sealed write. A
			// seal that failed (or a slot that turned out to be unavailable) keeps
			// the plaintext copy, and the user signed in, for the next launch to
			// retry; this session keeps the vault in memory only.
			if (await persistVault(legacy.accounts, legacy.activeUserId)) {
				await purgeLegacyVault();
			}
			const placeholder = hasPlaceholder(legacy);
			if (placeholder) {
				enrichLegacyAccount(placeholder.token).catch(() => undefined);
			}
			stored = vault;
		}
	}
	if (!stored || stored.accounts.length === 0) {
		setVault({ accounts: [], activeUserId: null });
		return;
	}
	const startupDefault = getStartupDefaultAccountId();
	const active =
		stored.accounts.find((a) => a.userId === startupDefault) ??
		stored.accounts.find((a) => a.userId === stored?.activeUserId) ??
		stored.accounts[0];
	if (active.userId === stored.activeUserId) {
		setVault(stored);
		return;
	}
	// A startup default is a real account switch, not only a token preference.
	await persistVault(stored.accounts, active.userId);
}

/** Resolves once the local auth vault has been hydrated from disk. */
export const vaultHydrated = hydrateVault().catch(() => undefined);

configureSettingsApi({ getToken: getTokenSync, baseUrl: BACKEND_URL });

export const authClient = createAuthClient({
	baseURL: BACKEND_URL,
	fetchOptions: {
		auth: {
			type: "Bearer",
			token: getTokenForAuth,
		},
	},
	plugins: [
		// Retained for deleting legacy guest sessions; sign-in is disabled by the
		// shared waitlist policy.
		anonymousClient(),
		twoFactorClient(),
		magicLinkClient(),
		usernameClient(),
		ryuOrganizationClient,
		inferAdditionalFields({
			user: {
				avatarId: { type: "string", required: false },
				isAnonymous: { type: "boolean", required: false },
				profileVisibility: { type: "string", required: false },
				referralCode: { type: "string", required: false },
				referralCount: { type: "number", required: false },
			},
		}),
	],
});

export const { useSession, signIn, signOut, signUp } = authClient;

/** Network clients read the bearer from the owning vault, not UI account data. */
export { getTokenSync as getActiveToken };
