import { configureSettingsApi } from "@ryu/settings";
import {
	inferAdditionalFields,
	magicLinkClient,
	twoFactorClient,
	usernameClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { BACKEND_URL, FRONTEND_URL } from "./app-urls.ts";
import { AUTH_CORE_URL } from "./core-url.ts";

export { BACKEND_URL, FRONTEND_URL };
// The active account's bearer token. Kept as a live mirror of whichever account
// is active in the multi-account vault so every existing consumer that reads
// `TOKEN_KEY` directly keeps working unchanged.
export const TOKEN_KEY = "ryu_session_token";
// The multi-account vault: an array of accounts + the active account's userId.
// Mirrored into both localStorage (for synchronous webview reads) and the Tauri
// `auth.bin` store (so it survives a localStorage wipe on reinstall).
const ACCOUNTS_KEY = "ryu_accounts";
const ACTIVE_USER_KEY = "ryu_active_user_id";
const WAITLIST_CACHE_KEY = "ryu_waitlist_approved";

/**
 * A signed-in account. Tokens NEVER leave the device: this shape (including the
 * raw bearer token) is stored only in the local vault. UI surfaces should render
 * the safe fields (userId, email, name, image) plus an `active` flag.
 */
export interface StoredAccount {
	email: string;
	image: string | null;
	name: string | null;
	token: string;
	userId: string;
}

function getTokenSync(): string | null {
	return localStorage.getItem(TOKEN_KEY);
}

function getTokenForAuth(): string | undefined {
	return getTokenSync() ?? undefined;
}

let storePromise: Promise<import("@tauri-apps/plugin-store").Store> | null =
	null;

function getAuthStore(): Promise<import("@tauri-apps/plugin-store").Store> {
	if (!storePromise) {
		storePromise = import("@tauri-apps/plugin-store").then(({ load }) =>
			load("auth.bin")
		);
	}
	return storePromise;
}

function readAccounts(): StoredAccount[] {
	try {
		const raw = localStorage.getItem(ACCOUNTS_KEY);
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as StoredAccount[]) : [];
	} catch {
		return [];
	}
}

function readActiveUserId(): string | null {
	return localStorage.getItem(ACTIVE_USER_KEY);
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

// Persist the vault to both stores and keep the legacy single-token mirror
// (`TOKEN_KEY` / `auth.bin:token`) pointed at whichever account is active, so
// the many consumers that read `TOKEN_KEY` directly stay correct.
async function persistVault(
	accounts: StoredAccount[],
	activeUserId: string | null
): Promise<void> {
	const active =
		accounts.find((a) => a.userId === activeUserId) ?? accounts[0] ?? null;
	const effectiveActiveId = active?.userId ?? null;

	localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
	if (effectiveActiveId) {
		localStorage.setItem(ACTIVE_USER_KEY, effectiveActiveId);
	} else {
		localStorage.removeItem(ACTIVE_USER_KEY);
	}
	if (active) {
		localStorage.setItem(TOKEN_KEY, active.token);
	} else {
		localStorage.removeItem(TOKEN_KEY);
	}

	try {
		const store = await getAuthStore();
		await store.set("accounts", accounts);
		if (effectiveActiveId) {
			await store.set("activeUserId", effectiveActiveId);
		} else {
			await store.delete("activeUserId");
		}
		if (active) {
			await store.set("token", active.token);
		} else {
			await store.delete("token");
		}
	} catch {
		// Tauri store unavailable (e.g. web context); localStorage is sufficient.
	}
}

// Resolve a raw bearer token to its account profile via the Better Auth bearer
// plugin. Never sends the token anywhere but the trusted backend.
async function fetchAccountProfile(token: string): Promise<{
	userId: string;
	email: string;
	name: string | null;
	image: string | null;
}> {
	const res = await fetch(`${BACKEND_URL}/api/auth/get-session`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) {
		throw new Error("Failed to resolve account profile");
	}
	const data = (await res.json()) as {
		user?: {
			id?: string;
			email?: string | null;
			name?: string | null;
			image?: string | null;
		};
	} | null;
	const user = data?.user;
	if (!user?.id) {
		throw new Error("Session response missing user");
	}
	return {
		userId: user.id,
		email: user.email ?? "",
		name: user.name ?? null,
		image: user.image ?? null,
	};
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
	localStorage.removeItem(WAITLIST_CACHE_KEY);
	await persistVault(accounts, profile.userId);
	return account;
}

/** Switch the active account. No-op if the userId is not in the vault. */
export async function switchAccount(userId: string): Promise<void> {
	const accounts = readAccounts();
	if (!accounts.some((a) => a.userId === userId)) {
		return;
	}
	localStorage.removeItem(WAITLIST_CACHE_KEY);
	await persistVault(accounts, userId);
}

/**
 * Remove one account from the vault. If it was active, fall back to another
 * account when present, otherwise leave the fully-logged-out state.
 */
export async function signOutAccount(userId: string): Promise<void> {
	const remaining = readAccounts().filter((a) => a.userId !== userId);
	const wasActive = getActiveUserId() === userId;
	if (wasActive) {
		localStorage.removeItem(WAITLIST_CACHE_KEY);
	}
	if (remaining.length === 0) {
		localStorage.removeItem(ACCOUNTS_KEY);
		localStorage.removeItem(ACTIVE_USER_KEY);
		localStorage.removeItem(TOKEN_KEY);
		try {
			const store = await getAuthStore();
			await store.delete("accounts");
			await store.delete("activeUserId");
			await store.delete("token");
		} catch {
			// Tauri store unavailable; localStorage already cleared.
		}
		return;
	}
	const nextActive = wasActive
		? remaining[0].userId
		: (readActiveUserId() ?? remaining[0].userId);
	await persistVault(remaining, nextActive);
}

export async function storeSessionToken(token: string): Promise<void> {
	try {
		await addAccount(token);
	} catch {
		// Profile fetch failed (offline / backend hiccup). Fall back to the legacy
		// single-token write so the user is still signed in; the vault self-heals
		// on the next hydrate (see hydrateVault's legacy migration).
		localStorage.removeItem(WAITLIST_CACHE_KEY);
		localStorage.setItem(TOKEN_KEY, token);
		try {
			const store = await getAuthStore();
			await store.set("token", token);
		} catch {
			// Tauri store unavailable (e.g. web context); localStorage is sufficient.
		}
	}
}

/** Clear Core's on-disk auth vault so device login cannot resurrect a stale token. */
export async function clearCoreAuth(): Promise<void> {
	try {
		await fetch(`${AUTH_CORE_URL}/api/auth/logout`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ all: true }),
		});
	} catch {
		// Core may be stopped; the desktop vault is still cleared below.
	}
}

export async function clearSessionToken(): Promise<void> {
	// Full sign-out: clear the entire vault (every account).
	localStorage.removeItem(TOKEN_KEY);
	localStorage.removeItem(ACCOUNTS_KEY);
	localStorage.removeItem(ACTIVE_USER_KEY);
	// Drop the cached waitlist-approval so the next account is re-checked clean.
	localStorage.removeItem(WAITLIST_CACHE_KEY);
	try {
		const store = await getAuthStore();
		await store.delete("token");
		await store.delete("accounts");
		await store.delete("activeUserId");
	} catch {
		// Tauri store unavailable; localStorage already cleared.
	}
	await clearCoreAuth();
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
	const wasActive = readActiveUserId() === accounts[idx].userId;
	accounts[idx] = { token, ...profile };
	const nextActive = wasActive
		? profile.userId
		: (readActiveUserId() ?? profile.userId);
	await persistVault(accounts, nextActive);
}

// On startup, ensure the vault is hydrated and the active-token mirror is set.
// Migrates a legacy single-token install into the vault as one account.
async function hydrateVault(): Promise<void> {
	// 1. localStorage vault already present — just re-assert the token mirror.
	const local = readAccounts();
	if (local.length > 0) {
		const active =
			local.find((a) => a.userId === readActiveUserId()) ?? local[0];
		localStorage.setItem(TOKEN_KEY, active.token);
		if (!readActiveUserId()) {
			localStorage.setItem(ACTIVE_USER_KEY, active.userId);
		}
		return;
	}

	// 2. Hydrate the vault from the Tauri store (localStorage was wiped).
	try {
		const store = await getAuthStore();
		const stored = await store.get<StoredAccount[]>("accounts");
		if (Array.isArray(stored) && stored.length > 0) {
			const storedActive =
				(await store.get<string>("activeUserId")) ?? stored[0].userId;
			const active = stored.find((a) => a.userId === storedActive) ?? stored[0];
			localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(stored));
			localStorage.setItem(ACTIVE_USER_KEY, active.userId);
			localStorage.setItem(TOKEN_KEY, active.token);
			return;
		}
	} catch {
		// Tauri store unavailable; fall through to legacy migration.
	}

	// 3. Legacy single-token migration: seed the vault with one account. Use the
	// token itself as a placeholder userId so it works offline, then enrich it
	// with the real profile in the background.
	let legacyToken = localStorage.getItem(TOKEN_KEY);
	if (!legacyToken) {
		try {
			const store = await getAuthStore();
			legacyToken = (await store.get<string>("token")) ?? null;
			if (legacyToken) {
				localStorage.setItem(TOKEN_KEY, legacyToken);
			}
		} catch {
			// Tauri store unavailable; nothing to migrate.
		}
	}
	if (legacyToken) {
		const placeholder: StoredAccount = {
			token: legacyToken,
			userId: legacyToken,
			email: "",
			name: null,
			image: null,
		};
		localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([placeholder]));
		localStorage.setItem(ACTIVE_USER_KEY, placeholder.userId);
		enrichLegacyAccount(legacyToken).catch(() => undefined);
	}
}

/** Resolves once the local auth vault has been hydrated from disk. */
export const vaultHydrated = hydrateVault().catch(() => undefined);

configureSettingsApi({ getToken: getTokenSync });

export const authClient = createAuthClient({
	baseURL: BACKEND_URL,
	fetchOptions: {
		auth: {
			type: "Bearer",
			token: getTokenForAuth,
		},
	},
	plugins: [
		twoFactorClient(),
		magicLinkClient(),
		usernameClient(),
		inferAdditionalFields({
			user: {
				avatarId: { type: "string", required: false },
				profileVisibility: { type: "string", required: false },
				referralCode: { type: "string", required: false },
				referralCount: { type: "number", required: false },
			},
		}),
	],
});

export const { useSession, signIn, signOut, signUp } = authClient;
