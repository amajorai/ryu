// The terminal's use of the shared declarative HTTP gate.
//
// A contributed view names the Core routes it reads and writes, and the shell
// sends those requests with the node's credentials. Every such request is built
// here by the two functions the desktop uses, `contributionSourceRequest` and
// `renderContributionActionHttp` of `@ryu/app-host/views`, with the owning plugin
// and the `http_policy` Core stamped on the view. A view of a Community app can
// reach its own `/api/ext/<plugin id>` mount and nothing else, and the test is
// made on the path a URL parser produces, so a tab or a line break cannot move
// the request to another route.
//
// The shell has no path test of its own. src/ui/ContributedView.tsx sends only
// the requests this module returns.

import {
	type ContributionHttpAuthority,
	contributionSourceRequest,
	isCoreApiPath,
	renderContributionActionHttp,
} from "@ryu/app-host/views";
import type { ContributedView } from "./contributions.ts";
import type { ViewActionContext, ViewActionHttp, ViewSource } from "./views.ts";

/** One request the shell may send with the node's credentials. */
export interface CoreViewRequest {
	body?: unknown;
	method: string;
	path: string;
}

/** The two fields of a view that decide which routes it may address. */
export type ViewOwner = Pick<ContributedView, "httpPolicy" | "plugin">;

function authorityOf(view: ViewOwner): ContributionHttpAuthority {
	return { plugin: view.plugin, http_policy: view.httpPolicy };
}

/** The automatic read of a view's source, or `null` when the gate refuses it. */
export function viewSourceRequest(
	view: ViewOwner,
	source: ViewSource | undefined
): CoreViewRequest | null {
	return contributionSourceRequest(authorityOf(view), source);
}

/** A fired action as a request. Throws when the rendered path is outside the
 *  routes the owning app may address. */
export function viewActionRequest(
	view: ViewOwner,
	http: ViewActionHttp,
	ctx: ViewActionContext
): CoreViewRequest {
	return renderContributionActionHttp(authorityOf(view), http, ctx);
}

/** The grant-gated `view.action` dispatch on the owning app's host bridge, or
 *  `null` when the view has no owner. The route is fixed by the shell. Only the
 *  plugin id comes from the view, encoded as one path segment. */
export function viewHostDispatchRequest(
	view: Pick<ContributedView, "plugin">,
	args: unknown
): CoreViewRequest | null {
	if (view.plugin.length === 0) {
		return null;
	}
	const path = `/api/plugins/${encodeURIComponent(view.plugin)}/host`;
	if (!isCoreApiPath(path)) {
		return null;
	}
	return { method: "POST", path, body: { method: "view.action", args } };
}
