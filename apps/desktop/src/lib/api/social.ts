// apps/desktop/src/lib/api/social.ts
//
// Typed client for the Outpost API (`/api/social/*`) — the `public_mount` Core serves
// on behalf of the `ryu-social` sidecar. Field names stay snake_case to match the
// sidecar's serde shapes exactly; the desktop never renames them, because the
// companion frame reads the same JSON on the other side of the bridge.
//
// ── Why this file is ONE function and not thirty-three ────────────────────────────
//
// Every other client here (`meetings.ts`, `mail.ts`, …) exposes a named function per
// endpoint, because a named DESKTOP caller consumes each one. Outpost has no desktop
// page: its whole surface is the sandboxed companion, which reaches the sidecar
// through the single generic `social.request` bridge verb. A per-endpoint client here
// would be thirty-three functions with no callers, drifting out of step with a sidecar
// whose routes are still moving.
//
// This file owns the fixed mount + method policy for the Outpost bridge. The shared
// desktop-host containment check lives in `app-request.ts`; the independent
// sandbox-side check remains in `@ryu/app-host/rpc`.

import {
	type AppRequestMethod,
	type AppRequestValue,
	type AppResponseValue,
	type MountedAppPathInput,
	mountedAppRequest,
	resolveMountedAppPath,
} from "./app-request.ts";
import type { ApiTarget } from "./client.ts";

/** The mount Core serves the `ryu-social` sidecar on. A CONSTANT, never a parameter:
 *  the whole point of the validation below is that the frame contributes the sub-path
 *  and nothing else. */
const SOCIAL_MOUNT = "/api/social";

/** Methods the forwarder will issue. A closed set, mirroring `SOCIAL_METHODS` in
 *  `@ryu/app-host/rpc` — the sidecar's router serves no others. */
const ALLOWED_METHODS: ReadonlySet<AppRequestMethod> = new Set([
	"GET",
	"POST",
	"PATCH",
	"DELETE",
]);

export type SocialMethod = "DELETE" | "GET" | "PATCH" | "POST";

export interface SocialRequestInput {
	/** JSON body. Omit for GET/DELETE. */
	body?: AppRequestValue;
	/** Defaults to `"GET"`. */
	method?: SocialMethod;
	/** Path RELATIVE to `/api/social`, leading slash included, query string and all. */
	path: string;
}

/**
 * Validate a frame-supplied sub-path and return the full node path, or `null` when it
 * is not a path under the Outpost mount.
 *
 * Exported so it can be tested directly — this is the check that decides whether a
 * capability-gated forwarder is a forwarder or an SSRF hole, and it should not be
 * reachable only through a React component.
 *
 * Rejects, in order:
 *  - a non-string, or one not starting with `/` — which covers every absolute URL
 *    (`https://evil/x`) and every bare-relative path;
 *  - a protocol-relative `//evil/x`, which a URL parser resolves as a different HOST
 *    even though it passes a naive "starts with /" check;
 *  - a backslash anywhere, because some URL parsers treat `\` as a separator and
 *    others do not — which is exactly how a traversal slips past a `/`-only test;
 *  - anything that does not RESOLVE to a path under the mount.
 *
 * ── Why the last check is a parser, not a `..` pattern ────────────────────────────
 *
 * This used to test the raw string against `/(^|\/)\.\.(\/|$)/` — a LITERAL `..`
 * only. `fetch` does not read the string, it reads the WHATWG URL parser's output,
 * and that parser treats `%2e%2e`, `%2E%2E`, `.%2e` and `%2e.` as double-dot
 * segments and collapses them. So `/%2e%2e/settings` passed the blocklist and
 * arrived as `/api/settings`, and `/%2e%2e/%2e%2e/plugins/x` escaped `/api/*`
 * entirely — a frame holding only `social:crud` could reach any path on the node
 * with the host's node bearer attached, and Core's own dot-segment guard never ran
 * because the request that left the desktop was already addressed to the escaped
 * path.
 *
 * A blocklist cannot win that race; it has to enumerate every encoding the parser
 * understands. So resolve with the same parser `fetch` will use and assert
 * containment, then return the NORMALIZED path — never the frame's raw string —
 * so the host and the parser can never disagree again about what was requested.
 */
export function resolveSocialPath(path: MountedAppPathInput): string | null {
	return resolveMountedAppPath(SOCIAL_MOUNT, path);
}

/**
 * Forward one companion call to the Outpost sidecar through Core.
 *
 * Resolves with the parsed JSON body and THROWS on any non-2xx (`request` raises a
 * typed `ApiError`), which is the contract every panel in the companion is written
 * against: try/catch plus a toast, never a status check.
 */
export async function socialRequest(
	target: ApiTarget,
	input: SocialRequestInput
): Promise<AppResponseValue> {
	return await mountedAppRequest(target, input, {
		allowedMethods: ALLOWED_METHODS,
		invalidMethodMessage: (method) =>
			`Refusing to forward an Outpost request with method "${method}".`,
		invalidPathMessage: (path) =>
			`Refusing to forward "${String(path)}" — an Outpost request path must be a sub-path of ${SOCIAL_MOUNT} beginning with "/" and containing no ".." segment.`,
		mount: SOCIAL_MOUNT,
	});
}
