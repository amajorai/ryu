import { dockTabKind } from "@/src/components/panels/dock-panels.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { request } from "@/src/lib/api/client.ts";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import { pluginDockSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import type { PluginDockPanel } from "@/src/lib/api/plugins.ts";

export const CONTRIBUTED_LINK_OPENED_EVENT = "ryu:contributed-link-opened";

export interface ContributedLinkOpenResult {
	kind: string;
	label: string;
}

function handlerFor(panels: PluginDockPanel[], url: URL) {
	return panels.find((panel) => {
		const handler = pluginDockSpec(panel)?.linkHandler;
		return handler?.schemes.includes(url.protocol.slice(0, -1));
	});
}

const PATH_BASE = "http://ryu.invalid";

/**
 * The handler path as fetch will actually send it, or null when that path
 * leaves the app's own ext-proxy mount. A raw prefix check is not enough:
 * fetch resolves `..` and `%2e%2e` segments, so `/api/ext/<app>/../../../node/…`
 * would pass it and still reach a Core route.
 */
function ownedHandlerPath(path: string, plugin: string): string | null {
	let resolved: URL;
	try {
		resolved = new URL(path, PATH_BASE);
	} catch {
		return null;
	}
	if (
		resolved.origin !== PATH_BASE ||
		!resolved.pathname.startsWith(`/api/ext/${plugin}/`)
	) {
		return null;
	}
	return `${resolved.pathname}${resolved.search}`;
}

/**
 * Open a URL through the first enabled app panel that declares a matching link
 * handler. The endpoint must live under that app's own generic ext-proxy mount.
 */
export async function openContributedLink(
	target: ApiTarget,
	panels: PluginDockPanel[],
	href: string
): Promise<ContributedLinkOpenResult | null> {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	const panel = handlerFor(panels, url);
	const handler = panel ? pluginDockSpec(panel)?.linkHandler : undefined;
	if (!(panel && handler)) {
		return null;
	}
	const ownedPath = ownedHandlerPath(handler.path, panel.plugin);
	if (!ownedPath) {
		return null;
	}
	await request(
		target,
		ownedPath,
		{
			method: handler.method ?? "POST",
			body: { [handler.bodyKey ?? "url"]: url.toString() },
		},
		gatewayJsonValueSchema
	);
	window.dispatchEvent(
		new CustomEvent(CONTRIBUTED_LINK_OPENED_EVENT, {
			detail: { plugin: panel.plugin, url: url.toString() },
		})
	);
	return { kind: dockTabKind(panel), label: panel.title };
}
