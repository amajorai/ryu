// Where a Core HTTP call of the plugin host is decided, before any credential
// exists.
//
// The renderer asks main to call Core for a declarative view (its `source` read
// and its `http` actions) and for a few routes of the host itself. Main holds the
// node token, so the decision is made here and not in the renderer:
//   - a call for a contribution names the owning plugin and the `http_policy`
//     Core stamped on it. It may address that app's own `/api/ext/<plugin id>`
//     mount, or any Core route only when Core stamped `"core"`.
//   - a call of the host itself must be one of the fixed routes below.
// The test is made twice. First on the path as written, with the shared gate of
// `@ryu/app-host/views`. Then on the URL built with `new URL`, because a URL
// parser drops every tab, line feed and carriage return and only then resolves
// dot segments, so a raw prefix test can pass for a path that is sent elsewhere.
//
// This file has no Electron or config import, so its test runs without either.
// `pluginCoreHttp` in ./plugin-host.ts passes the real base URL and sender.

import { isContributionHttpPathAllowed } from "@ryu/app-host/views";
import type {
	PluginCoreHttpOwner,
	PluginCoreHttpRequest,
	PluginCoreHttpResult,
} from "../../shared/ipc.ts";

/** HTTP methods a declarative view action may use. The same list as
 *  `VIEW_ACTION_HTTP_METHODS` of `@ryu/app-host/views`. */
const CORE_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** The routes the host calls for itself, not for an app's view. One entry per
 *  call site in the renderer (`listAgents` and the three widget round-trips). */
const HOST_ROUTES = new Set([
	"GET /api/agents",
	"POST /api/widgets/follow-up",
	"POST /api/widgets/state",
	"POST /api/widgets/tools/call",
]);

/** A call that passed the gate. `url` is the parsed, normalized address. */
export interface CoreHttpAllowed {
	method: string;
	ok: true;
	/** The path as the caller wrote it, for messages only. */
	path: string;
	url: string;
}

export interface CoreHttpRefused {
	code: "invalid_args";
	message: string;
	ok: false;
}

/** Sends an allowed call. The real one attaches the node's credentials. */
export type CoreHttpSender = (
	target: CoreHttpAllowed,
	body: unknown
) => Promise<PluginCoreHttpResult>;

function refuse(message: string): CoreHttpRefused {
	return { ok: false, code: "invalid_args", message };
}

/** The address a request for `path` is sent to and the pathname Core receives
 *  (after the base URL's own path prefix), or `null` when the result is not a
 *  path under the configured node. */
function sentPath(
	coreBaseUrl: string,
	path: string
): { href: string; pathname: string } | null {
	let base: URL;
	let url: URL;
	try {
		base = new URL(coreBaseUrl);
		url = new URL(`${coreBaseUrl}${path}`);
	} catch {
		return null;
	}
	const prefix = base.pathname.replace(/\/+$/, "");
	if (
		url.origin !== base.origin ||
		url.username !== base.username ||
		url.password !== base.password ||
		!url.pathname.startsWith(`${prefix}/`)
	) {
		return null;
	}
	return { href: url.href, pathname: url.pathname.slice(prefix.length) };
}

function isUnder(pathname: string, mount: string): boolean {
	return pathname === mount || pathname.startsWith(`${mount}/`);
}

/** The route test on the pathname the parser produced. */
function isSentPathAllowed(
	coreBaseUrl: string,
	plugin: string,
	httpPolicy: unknown,
	pathname: string
): boolean {
	if (httpPolicy === "core") {
		return pathname.startsWith("/api/") || isUnder(pathname, "/workflows");
	}
	const mount = sentPath(coreBaseUrl, `/api/ext/${plugin}`)?.pathname;
	return mount !== undefined && isUnder(pathname, mount);
}

/** Decide one call. Pure, with no request and no credential. */
export function coreHttpTarget(
	req: PluginCoreHttpRequest,
	coreBaseUrl: string
): CoreHttpAllowed | CoreHttpRefused {
	// The request crossed IPC, so its shape is checked and not assumed.
	const method = typeof req.method === "string" ? req.method.toUpperCase() : "";
	if (!CORE_HTTP_METHODS.has(method)) {
		return refuse(`unsupported method '${String(req.method)}'`);
	}
	const owner: PluginCoreHttpOwner | undefined = req.owner;
	const path: unknown = req.path;
	if (typeof path !== "string") {
		return refuse("view http path must be a string");
	}
	const sent = sentPath(coreBaseUrl, path);
	if (!sent) {
		return refuse(`view http path is not a path on the node: ${path}`);
	}
	if (owner?.kind === "host") {
		if (!(HOST_ROUTES.has(`${method} ${path}`) && sent.pathname === path)) {
			return refuse(`not a route of the host: ${method} ${path}`);
		}
		return { ok: true, method, path, url: sent.href };
	}
	if (owner?.kind !== "contribution" || typeof owner.plugin !== "string") {
		return refuse("a Core HTTP call must name the contribution it is for");
	}
	const authority = { plugin: owner.plugin, http_policy: owner.http_policy };
	if (
		!(
			isContributionHttpPathAllowed(authority, path) &&
			isSentPathAllowed(
				coreBaseUrl,
				owner.plugin,
				owner.http_policy,
				sent.pathname
			)
		)
	) {
		return refuse(
			`view http path is outside the owning app authority: ${path}`
		);
	}
	return { ok: true, method, path, url: sent.href };
}

/** Decide, then send. A refused call never reaches `send`, so no header is
 *  built and nothing is fetched for it. */
export async function pluginCoreHttpVia(
	req: PluginCoreHttpRequest,
	coreBaseUrl: string,
	send: CoreHttpSender
): Promise<PluginCoreHttpResult> {
	const target = coreHttpTarget(req, coreBaseUrl);
	if (!target.ok) {
		return target;
	}
	return await send(target, req.body);
}
