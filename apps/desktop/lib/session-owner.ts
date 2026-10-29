import { z } from "zod";

// Which vault account the live session bearer belongs to.
//
// `TOKEN_KEY` is a mirror of the active vault account's bearer, but some paths
// write it without a vault row (the offline sign-in fallback stores a bearer
// whose profile could not be resolved yet) while the active-user selector still
// names the previous account. Account-scoped state must therefore resolve only
// when the selector, the vault row and the live bearer all agree; otherwise the
// session is unverified and owns nothing.
//
// Dependency-free on purpose: account-scoped modules import this directly, so
// it reads the same storage keys the auth client writes.

export const TOKEN_KEY = "ryu_session_token";
export const ACCOUNTS_KEY = "ryu_accounts";
export const ACTIVE_USER_KEY = "ryu_active_user_id";

/**
 * Where the vault lives is the auth client's business: once it keeps the vault
 * sealed in memory (no plaintext localStorage mirror) it registers itself here,
 * and the checks below answer from it. Without a source (unit tests, a host
 * that never loads the auth client) they read the legacy storage keys.
 */
export interface VaultOwnerSource {
	accountCount(): number;
	verifiedActiveUserId(): string | null;
}

let vaultSource: VaultOwnerSource | null = null;

/** The auth client's registration; returns an unregister function. */
export function registerVaultOwnerSource(source: VaultOwnerSource): () => void {
	vaultSource = source;
	return () => {
		if (vaultSource === source) {
			vaultSource = null;
		}
	};
}

const vaultOwnersSchema = z.array(
	z.looseObject({ token: z.string(), userId: z.string() })
);

/**
 * The active account's userId when the live bearer is that account's vault
 * token, or null (signed out, a switch in progress, or an unverified bearer).
 * Selects the active account the same way the auth client does: the recorded
 * active user, falling back to the first account.
 */
export function getVerifiedActiveUserId(): string | null {
	if (vaultSource) {
		return vaultSource.verifiedActiveUserId();
	}
	try {
		const token = localStorage.getItem(TOKEN_KEY);
		if (!token) {
			return null;
		}
		const accounts = vaultOwnersSchema.safeParse(
			JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? "[]")
		);
		if (!accounts.success) {
			return null;
		}
		const activeId = localStorage.getItem(ACTIVE_USER_KEY);
		const active =
			accounts.data.find((account) => account.userId === activeId) ??
			accounts.data[0];
		return active?.token === token ? active.userId : null;
	} catch {
		// No storage or a corrupt vault: nothing is verified.
		return null;
	}
}

/** How many accounts the vault holds (0 when absent or unreadable). */
export function vaultAccountCount(): number {
	if (vaultSource) {
		return vaultSource.accountCount();
	}
	try {
		const accounts = vaultOwnersSchema.safeParse(
			JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? "[]")
		);
		return accounts.success ? accounts.data.length : 0;
	} catch {
		return 0;
	}
}
