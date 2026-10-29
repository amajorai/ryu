import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The server-only marker that lets the root-admin abuse console call Better
 * Auth's account-control endpoints (`banUser`, `unbanUser`, `setRole`, ...).
 *
 * Those endpoints are refused as raw HTTP paths by
 * `adminAbuseGuardPlugin` (see admin-abuse-guard-plugin.ts). The only way
 * through is a direct `auth.api.*` call made inside `runInAdminAbuseContext`,
 * which the admin-abuse router does after the hardened platform-admin gate,
 * step-up, any second-admin approval and its own ledger write.
 *
 * The marker is an `AsyncLocalStorage` store, never a header, cookie or body
 * field: nothing a client sends can set it, and an incoming HTTP request
 * always starts outside it. Code inside the context must call `auth.api.*`
 * only, never `auth.handler`, so a request object built from client input can
 * never run with the marker attached.
 */

interface AdminAbuseMarker {
	readonly marker: typeof ADMIN_ABUSE_MARKER;
}

const ADMIN_ABUSE_MARKER: unique symbol = Symbol("ryu.admin-abuse");

const adminAbuseStorage = new AsyncLocalStorage<AdminAbuseMarker>();

/**
 * Run `operation` with the admin-abuse marker set. Call this only after the
 * caller has passed `requirePlatformAdmin` and `platform.admin` step-up.
 */
export function runInAdminAbuseContext<T>(
	operation: () => Promise<T>
): Promise<T> {
	return adminAbuseStorage.run({ marker: ADMIN_ABUSE_MARKER }, operation);
}

/** True only inside `runInAdminAbuseContext`. */
export function isInAdminAbuseContext(): boolean {
	return adminAbuseStorage.getStore()?.marker === ADMIN_ABUSE_MARKER;
}
