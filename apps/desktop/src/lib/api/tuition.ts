// apps/desktop/src/lib/api/tuition.ts
//
// Typed client for the Tuition API (`/api/tuition/*`) — the
// `public_mount` Core serves on behalf of the `ryu-tuition` sidecar. Field names
// stay snake_case to match the sidecar's serde shapes exactly; the desktop never
// renames them, because the companion frame reads the same JSON on the other side of
// the bridge.
//
// ── Why this file is ONE function ─────────────────────────────────────────────────
//
// The same reason `social.ts` is: tuition has no desktop page. Its whole surface is
// the sandboxed companion, which reaches the sidecar through the single generic
// `tuition.request` bridge verb, so a per-endpoint client here would be seven
// functions with no callers.
//
// What this module does own is the fixed mount + method policy for the Tuition
// bridge. The shared desktop-host containment check lives in `app-request.ts`;
// the independent sandbox-side check remains in `@ryu/app-host/rpc`.

import {
	type AppRequestMethod,
	type AppRequestValue,
	type AppResponseValue,
	type MountedAppPathInput,
	mountedAppRequest,
	resolveMountedAppPath,
} from "./app-request.ts";
import type { ApiTarget } from "./client.ts";

/** The mount Core serves the `ryu-tuition` sidecar on. A CONSTANT, never a
 *  parameter: the whole point of the validation below is that the frame contributes
 *  the sub-path and nothing else. */
const TUITION_MOUNT = "/api/tuition";

/** Methods the forwarder will issue. A closed set, mirroring `APP_CRUD_METHODS` in
 *  `@ryu/app-host/rpc` — the sidecar's router serves no others. */
const ALLOWED_METHODS: ReadonlySet<AppRequestMethod> = new Set([
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
]);

export type TuitionMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface TuitionRequestInput {
	/** JSON body. Omit for GET/DELETE. */
	body?: AppRequestValue;
	/** Defaults to `"GET"`. */
	method?: TuitionMethod;
	/** Path RELATIVE to `/api/tuition`, leading slash included, query and all. */
	path: string;
}

/**
 * Validate a frame-supplied sub-path and return the full node path, or `null` when it
 * is not a path under the tuition mount.
 *
 * Exported so it can be tested directly — this is the check that decides whether a
 * capability-gated forwarder is a forwarder or an SSRF hole, and it should not be
 * reachable only through a React component.
 *
 * Rejects, in order: a non-string or one not starting with `/` (which covers every
 * absolute URL and every bare-relative path); a protocol-relative `//evil/x`, which a
 * URL parser resolves as a different HOST; a backslash, which some parsers treat as a
 * separator and others do not — the gap a traversal slips through; and anything that
 * does not RESOLVE under the mount once the WHATWG parser has had its say. That last
 * one is the important clause: matching the parser's output rather than blocklisting
 * `..` is what stops `%2e%2e` and its variants, which decode into dot segments only
 * AFTER a literal check would have run.
 */
export function resolveTuitionPath(path: MountedAppPathInput): string | null {
	return resolveMountedAppPath(TUITION_MOUNT, path);
}

/**
 * Forward one companion call to the tuition sidecar through Core.
 *
 * Resolves with the parsed JSON body and THROWS on any non-2xx (`request` raises a
 * typed `ApiError`), which is the contract the companion is written against: try/catch
 * plus an error banner, never a status check.
 */
export async function tuitionRequest(
	target: ApiTarget,
	input: TuitionRequestInput
): Promise<AppResponseValue> {
	return await mountedAppRequest(target, input, {
		allowedMethods: ALLOWED_METHODS,
		invalidMethodMessage: (method) =>
			`Refusing to forward a tuition request with method "${method}".`,
		invalidPathMessage: (path) =>
			`Refusing to forward "${String(path)}" — a tuition request path must be a sub-path of ${TUITION_MOUNT} beginning with "/" and containing no ".." segment.`,
		mount: TUITION_MOUNT,
	});
}
