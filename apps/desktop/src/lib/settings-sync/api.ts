import { z } from "zod";
// Typed client for the settings-sync routes on the control-plane server
// (:3000, BACKEND_URL), authenticated with the Better Auth session bearer —
// the same transport `campaigns.ts` and `billing.ts` use.
//
// NOT a Core node call. Settings sync is account-scoped by definition: the whole
// point is that a second machine, with its own Core, sees what the first one
// saved. A node-scoped store could not do that.

import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";
import { getVerifiedActiveUserId } from "@/lib/session-owner.ts";

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/desktop-settings-sync`;

export interface SyncEntry {
	deleted?: boolean;
	key: string;
	updatedAt: number;
	value: string | null;
}

export interface PullResult {
	entries: SyncEntry[];
	revision: number;
	updatedAt: number;
}

export interface PushResult {
	applied: string[];
	/** The server's newer version of each key this push was too old for. */
	rejected: SyncEntry[];
	revision: number;
	/** Keys whose exact edit time and value the server already stores. Absent
	 *  from servers that predate it. */
	unchanged?: string[];
	updatedAt: number;
}

const syncEntrySchema = z.object({
	deleted: z.boolean().optional(),
	key: z.string(),
	updatedAt: z.number(),
	value: z.string().nullable(),
});
const pullResultSchema = z.object({
	entries: z.array(syncEntrySchema),
	revision: z.number(),
	updatedAt: z.number(),
});
const pushResultSchema = z.object({
	applied: z.array(z.string()),
	rejected: z.array(syncEntrySchema),
	revision: z.number(),
	unchanged: z.array(z.string()).optional(),
	updatedAt: z.number(),
});

export interface SyncIdentity {
	token: string;
	userId: string;
}

function authToken(): string | null {
	try {
		return getActiveToken();
	} catch {
		// No storage — treated as signed out.
		return null;
	}
}

function activeIdentity(): SyncIdentity | null {
	const token = authToken();
	const userId = getVerifiedActiveUserId();
	return token && userId ? { token, userId } : null;
}

/** The live bearer is still this identity's, and the vault says it is theirs. */
function identityIsCurrent(identity: SyncIdentity): boolean {
	return (
		authToken() === identity.token &&
		getVerifiedActiveUserId() === identity.userId
	);
}

function headers(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	} satisfies NonNullable<RequestInit["headers"]>;
}

/**
 * Everything changed at or after `since`. Returns null when signed out or the
 * server is unreachable — sync is an enhancement, never a reason for the app to
 * report an error at the user.
 */
export async function pullSettings(
	since = 0,
	identity: SyncIdentity | null = activeIdentity()
): Promise<PullResult | null> {
	if (!(identity && identityIsCurrent(identity))) {
		return null;
	}
	try {
		const resp = await fetch(`${BASE}/pull?since=${since}`, {
			headers: headers(identity.token),
		});
		if (!resp.ok) {
			return null;
		}
		return pullResultSchema.parse(await resp.json());
	} catch {
		return null;
	}
}

/** Merge a batch upward. Null on failure, so the caller keeps its dirty set. */
export async function pushSettings(
	entries: SyncEntry[],
	identity: SyncIdentity | null = activeIdentity()
): Promise<PushResult | null> {
	if (!(identity && identityIsCurrent(identity)) || entries.length === 0) {
		return null;
	}
	try {
		const resp = await fetch(`${BASE}/push`, {
			method: "POST",
			headers: headers(identity.token),
			body: JSON.stringify({ entries }),
		});
		if (!resp.ok) {
			return null;
		}
		return pushResultSchema.parse(await resp.json());
	} catch {
		return null;
	}
}

/**
 * Forget the server-side copy entirely. Local settings are untouched.
 *
 * `identity` is the account the user confirmed the deletion for. If the active
 * session has changed since, nothing is sent: a confirmation given for one
 * account must never delete another account's copy.
 */
export async function resetRemoteSettings(
	identity: SyncIdentity | null
): Promise<boolean> {
	if (!(identity && identityIsCurrent(identity))) {
		return false;
	}
	try {
		const resp = await fetch(BASE, {
			method: "DELETE",
			headers: headers(identity.token),
		});
		return resp.ok;
	} catch {
		return false;
	}
}

/**
 * A best-effort flush that survives the window going away.
 *
 * `keepalive: true` rather than `navigator.sendBeacon`: a beacon cannot carry an
 * Authorization header, and this API authenticates by bearer only — a beacon
 * would be queued, delivered, and 401'd, which is worse than not sending it,
 * because it looks like it worked. Keepalive fetch keeps the header and is
 * allowed to outlive the document.
 *
 * Errors are swallowed: this runs while the window is closing, where there is
 * nobody left to tell.
 */
export function flushSettings(
	entries: SyncEntry[],
	identity: SyncIdentity | null = activeIdentity()
): void {
	if (!(identity && identityIsCurrent(identity)) || entries.length === 0) {
		return;
	}
	try {
		void fetch(`${BASE}/push`, {
			method: "POST",
			headers: headers(identity.token),
			body: JSON.stringify({ entries }),
			keepalive: true,
		}).catch(() => undefined);
	} catch {
		// Nothing to do — the window is going away.
	}
}
