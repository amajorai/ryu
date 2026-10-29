// apps/desktop/src/lib/api/subtitles.ts
//
// Typed client for the Subtitles API (`/api/subtitles/*`) — the `public_mount` Core
// serves on behalf of the `ryu-subtitles` sidecar. Field names stay snake_case to
// match the sidecar's serde shapes exactly; the desktop never renames them, because
// the companion frame reads the same JSON on the other side of the bridge.
//
// ── Why this file is ONE function and not ten ─────────────────────────────────────
//
// Same reasoning as `social.ts`: Subtitles has no desktop page. Its whole surface is
// the sandboxed companion, which reaches the sidecar through the single generic
// `subtitles.request` bridge verb, so a per-endpoint client here would be ten
// functions with no callers.
//
// This file owns the fixed mount + method policy and the download route's text
// response. The shared desktop-host containment check lives in `app-request.ts`;
// the independent sandbox-side check remains in `@ryu/app-host/rpc`.

import {
	type AppRequestMethod,
	type AppRequestValue,
	type AppResponseValue,
	type MountedAppPathInput,
	requestValidatedMountedApp,
	resolveMountedAppPath,
	validateMountedAppRequest,
} from "./app-request.ts";
import { type ApiTarget, apiUrl, requestHeaders } from "./client.ts";

/** The mount Core serves the `ryu-subtitles` sidecar on. A CONSTANT, never a
 *  parameter: the whole point of the validation below is that the frame contributes
 *  the sub-path and nothing else. */
const SUBTITLES_MOUNT = "/api/subtitles";

/** Methods the forwarder will issue. A closed set, mirroring `SUBTITLES_METHODS` in
 *  `@ryu/app-host/rpc` — the sidecar's router serves no others. */
const ALLOWED_METHODS: ReadonlySet<AppRequestMethod> = new Set([
	"GET",
	"POST",
	"PUT",
	"DELETE",
]);

/** A base that exists only to give `new URL()` something to resolve against. Never
 *  reaches a socket: only `pathname`/`search` are read back off the result, and the
 *  real base is applied later by `apiUrl`. */
const PARSE_BASE = "http://subtitles.invalid";

export type SubtitlesMethod = "DELETE" | "GET" | "POST" | "PUT";

export interface SubtitlesRequestInput {
	/** JSON body. Omit for GET/DELETE. */
	body?: AppRequestValue;
	/** Defaults to `"GET"`. */
	method?: SubtitlesMethod;
	/** Path RELATIVE to `/api/subtitles`, leading slash included, query string and
	 *  all. */
	path: string;
}

/**
 * Validate a frame-supplied sub-path and return the full node path, or `null` when it
 * is not a path under the Subtitles mount.
 *
 * Exported so it can be tested directly — this is the check that decides whether a
 * capability-gated forwarder is a forwarder or an SSRF hole, and it should not be
 * reachable only through a React component.
 *
 * Rejects, in order: a non-string or one not starting with `/` (which covers every
 * absolute URL and every bare-relative path); a protocol-relative `//evil/x`, which a
 * URL parser resolves as a different HOST despite passing a naive "starts with /"
 * test; a backslash anywhere, because some URL parsers treat `\` as a separator and
 * others do not; and anything that does not RESOLVE to a path under the mount.
 *
 * The last check is a PARSER, not a `..` pattern, and that is the load-bearing
 * detail. `fetch` does not read the string — it reads the WHATWG URL parser's output,
 * which treats `%2e%2e`, `%2E%2E`, `.%2e` and `%2e.` as double-dot segments and
 * collapses them. A literal-`..` blocklist therefore lets `/%2e%2e/settings` through
 * as `/api/settings`, with the host's node bearer attached (this is exactly the bug
 * the Outpost forwarder shipped and was fixed for). So: resolve with the same parser
 * `fetch` will use, assert containment, and return the NORMALIZED path — never the
 * frame's raw string — so the host and the parser cannot disagree about what was
 * requested.
 */
export function resolveSubtitlesPath(path: MountedAppPathInput): null | string {
	return resolveMountedAppPath(SUBTITLES_MOUNT, path);
}

/** Whether a resolved path is the download route, whose response is a subtitle FILE
 *  and not JSON. Matched on the path segment rather than a caller-supplied flag, so
 *  the frame cannot ask for a JSON route to be read as text or the reverse. */
function isDownloadPath(path: string): boolean {
	return new URL(path, PARSE_BASE).pathname.endsWith("/download");
}

/**
 * Forward one companion call to the Subtitles sidecar through Core.
 *
 * Resolves with the parsed JSON body — except for `/jobs/:id/download`, which resolves
 * with the subtitle file's TEXT, because that route answers `application/x-subrip` or
 * `text/vtt`. The shared `request` helper throws on a non-JSON 200 (it reads that as
 * an SPA fallback, which for every other endpoint it is), so the download route takes
 * the raw-fetch path below rather than being papered over by loosening that check for
 * everyone.
 *
 * Throws on any non-2xx, which is the contract the companion is written against:
 * try/catch plus a toast, never a status check.
 */
export async function subtitlesRequest(
	target: ApiTarget,
	input: SubtitlesRequestInput
): Promise<AppResponseValue> {
	const validated = validateMountedAppRequest(input, {
		allowedMethods: ALLOWED_METHODS,
		invalidMethodMessage: (method) =>
			`Refusing to forward a Subtitles request with method "${method}".`,
		invalidPathMessage: (path) =>
			`Refusing to forward "${String(path)}" — a Subtitles request path must be a sub-path of ${SUBTITLES_MOUNT} beginning with "/" and containing no ".." segment.`,
		mount: SUBTITLES_MOUNT,
	});

	if (validated.method === "GET" && isDownloadPath(validated.path)) {
		const response = await fetch(apiUrl(target, validated.path), {
			headers: await requestHeaders(target),
			method: "GET",
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				text || `The subtitle file could not be read (${response.status}).`
			);
		}
		return text;
	}

	return await requestValidatedMountedApp(target, validated);
}
