import { APIError } from "better-auth/api";

/*
 * Better Auth's native `GET /list-sessions` answers every live session row of
 * the caller's account, `token` column included. Nothing in this repo calls
 * it over HTTP: the web app, the CLI and Desktop list sessions through the
 * API's `/api/sessions`, which calls `auth.api.listSessions` in process and
 * returns no token at all. So the native route is closed to HTTP callers.
 *
 * The rows it would return carry a handle instead of another session's raw
 * token anyway (`auth-token-at-rest.ts`); this is the second lock on the same
 * door, so a regression there does not hand one session of an account the
 * bearer token of another.
 */

const NATIVE_SESSION_LIST_PATH = "/list-sessions";

/** The fields of a Better Auth hook context the guard reads. */
export interface NativeSessionListGuardContext {
	readonly path?: string;
	readonly request?: unknown;
}

/**
 * Refuse the native session listing when it was called over HTTP. A server
 * call (`auth.api.listSessions({ headers })`) carries no `request` and is
 * left alone.
 */
export function rejectNativeSessionListOverHttp(
	ctx: NativeSessionListGuardContext
): void {
	if (ctx.path === NATIVE_SESSION_LIST_PATH && ctx.request) {
		throw new APIError("NOT_FOUND", { message: "Not found" });
	}
}
