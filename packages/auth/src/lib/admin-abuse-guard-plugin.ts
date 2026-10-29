import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { isInAdminAbuseContext } from "./admin-abuse-context.ts";

/**
 * Better Auth admin-plugin endpoints that change who an account is or whether
 * it may sign in. A `role: "admin"` session could otherwise call them straight
 * from `authClient.admin`, bypassing the pinned platform-admin gate, the
 * second-admin approval and the platform admin audit.
 *
 * `create-user` and `update-user` are here too: both accept `role`, `banned`,
 * `banReason`, `banExpires` and `emailVerified` in their body, so leaving them
 * open would be a side door around `ban-user` and `set-role`.
 *
 * Paths match exactly, like `STEP_UP_AUTH_PATHS`. Re-read this list against
 * the admin plugin's routes when upgrading `better-auth`.
 */
export const ADMIN_ABUSE_GUARDED_PATHS: ReadonlySet<string> = new Set([
	"/admin/ban-user",
	"/admin/unban-user",
	"/admin/set-role",
	"/admin/remove-user",
	"/admin/set-user-password",
	"/admin/revoke-user-session",
	"/admin/revoke-user-sessions",
	"/admin/create-user",
	"/admin/update-user",
]);

/** True when this Better Auth path is reserved for the admin-abuse console. */
export function isAdminAbuseGuardedPath(path: string): boolean {
	return ADMIN_ABUSE_GUARDED_PATHS.has(path);
}

/**
 * Refuses the guarded admin endpoints with 404 unless the call runs inside
 * `runInAdminAbuseContext`.
 *
 * 404 rather than 403, matching Better Auth's own answer for server-only
 * endpoints: the raw HTTP path should look like it does not exist. Register
 * this BEFORE `stepUpGate()`, or a caller without step-up would get a 403
 * `STEP_UP_REQUIRED` first, which confirms the endpoint is there.
 *
 * The marker is the only authority: a server-side `auth.api.banUser` call made
 * anywhere outside the abuse console is refused the same way as a raw HTTP
 * call. A call that carries an HTTP `Request` is refused even inside the
 * context, so `auth.handler` invoked from marked code still cannot pass a
 * client's request through.
 */
export function adminAbuseGuardPlugin(): BetterAuthPlugin {
	return {
		id: "ryu-admin-abuse-guard",
		hooks: {
			before: [
				{
					matcher: (context: { path?: string }) =>
						isAdminAbuseGuardedPath(context.path ?? ""),
					handler: createAuthMiddleware(async (ctx) => {
						if (isInAdminAbuseContext() && !ctx.request) {
							return;
						}
						throw new APIError("NOT_FOUND");
					}),
				},
			],
		},
	};
}
