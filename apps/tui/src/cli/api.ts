// The real {@link CoreApi} bundle: the typed core-client plugin-lifecycle calls
// plus the tui's own SSE chat client. Handlers receive this via the CliContext, so
// nothing here is imported by them directly — that indirection is the test seam
// (bun tests pass a fake CoreApi and never touch the network).

import type { ApiTarget } from "@ryuhq/core-client/client";
import { apiUrl, makeHeaders } from "@ryuhq/core-client/client";
import {
	disableApp,
	enableApp,
	fetchApps,
	fetchAppsCatalog,
	installApp,
	isSafeCommandPath,
	uninstallApp,
} from "@ryuhq/core-client/plugins";
import { streamChat } from "../core/chatStream.ts";
import type { CoreApi } from "./types.ts";

/** HTTP verbs that carry a request body; the rest encode args in the query. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Route one `ryu <app> <cmd> [args…]` call to the app's sidecar through Core's
 *  generic `ext_proxy` (`/api/ext/<pluginId><path>`). Args-passthrough convention:
 *  body methods send `{ args }` as JSON; query methods append
 *  `?args=<json>`. Never throws on a non-2xx — returns the raw status + text so
 *  the dispatcher owns the exit-code mapping. */
async function execAppCommand(
	target: ApiTarget,
	pluginId: string,
	cmd: { method: string; path: string },
	args: string[]
): Promise<{ body: string; status: number }> {
	// Defence-in-depth (the manifest loader + toAppCommands already drop unsafe
	// paths): never build a request URL from a traversal path. A `..`/`%2e`/`\`
	// path would be normalized by the URL parser to escape `/api/ext/<id>/` and hit
	// an arbitrary internal route with the node bearer — refuse it before fetch.
	if (!isSafeCommandPath(cmd.path)) {
		return {
			status: 400,
			body: `refusing to run command: unsafe path '${cmd.path}'`,
		};
	}
	const method = cmd.method.toUpperCase();
	const hasBody = BODY_METHODS.has(method);
	const path = hasBody
		? `/api/ext/${pluginId}${cmd.path}`
		: `/api/ext/${pluginId}${cmd.path}?args=${encodeURIComponent(JSON.stringify(args))}`;
	const resp = await fetch(apiUrl(target, path), {
		method,
		headers: makeHeaders(target.token),
		body: hasBody ? JSON.stringify({ args }) : undefined,
	});
	return { status: resp.status, body: await resp.text() };
}

/** The production CoreApi wired to a live Core node over HTTP. */
export const realCoreApi: CoreApi = {
	disableApp,
	enableApp,
	execAppCommand,
	fetchApps,
	fetchAppsCatalog,
	installApp,
	streamChat,
	uninstallApp,
};
