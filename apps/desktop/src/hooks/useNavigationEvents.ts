import { isShellSafeRoute } from "@ryu/app-host/rpc";
import { useEffect, useRef } from "react";
import { getActiveUserId, useSession } from "@/lib/auth-client.ts";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type NavigationRequest,
	streamNavigationRequests,
} from "@/src/lib/api/navigation.ts";
import { pageLabel, pageRoute } from "@/src/lib/page-routes.ts";
import { isMainWindow } from "@/src/lib/window-routing.ts";
import { useBrowserOpenRequestStore } from "@/src/store/useBrowserOpenRequestStore.ts";
import { useDockPanelRequestStore } from "@/src/store/useDockPanelRequestStore.ts";
import { useSidePanelRouteStore } from "@/src/store/useSidePanelRouteStore.ts";

const BROWSER_PANEL_KIND = "plugin:@ryu/browser:browser";

function isHttpUrl(value: string): boolean {
	return (
		/^https?:\/\//i.test(value) &&
		!value.includes("\n") &&
		!value.includes("\r")
	);
}

function isAgentRequest(request: NavigationRequest): boolean {
	return request.plugin_id === "agent";
}

/** Consume one server-authenticated navigation request in the main shell. */
function consumeNavigationRequest(
	request: NavigationRequest,
	currentUserId: string | null,
	openTab: ReturnType<typeof useTabsContext>["openTab"]
): void {
	if (request.target_user_id && request.target_user_id !== currentUserId) {
		return;
	}
	const target = request.target.trim();
	if (!target) {
		return;
	}

	if (request.kind === "browser") {
		if (!isHttpUrl(target)) {
			return;
		}
		// Queue the URL before raising the panel: BrowserTabPanel may mount as a
		// result of the second call, and it consumes the pending URL on mount.
		useBrowserOpenRequestStore.getState().open(target);
		useDockPanelRequestStore.getState().open(BROWSER_PANEL_KIND, "Browser");
		return;
	}

	if (isAgentRequest(request)) {
		const route = pageRoute(target);
		if (!route) {
			return;
		}
		if (request.kind === "panel") {
			useSidePanelRouteStore.getState().openPage(target);
			return;
		}
		openTab(route, {
			forceNew: request.force_new === true,
			title: pageLabel(target),
		});
		return;
	}

	// Legacy `host.navigate` requests carry a raw first-party route. Keep the
	// host-side anti-phishing allowlist as a second gate before opening it.
	const pluginId = request.plugin_id?.trim();
	if (!pluginId || request.kind === "panel") {
		return;
	}
	const ownPluginPath = `/plugin/${encodeURIComponent(pluginId)}`;
	if (!isShellSafeRoute(target, ownPluginPath)) {
		return;
	}
	openTab(target, { forceNew: request.force_new === true });
}

/** Subscribe once at shell level so an agent action affects only the main Ryu
 * window, while tear-off/companion windows remain independent. */
export function useNavigationEvents(): void {
	const node = useActiveNode();
	const { openTab } = useTabsContext();
	const { data: session } = useSession();
	const sessionUserId = session?.user?.id ?? getActiveUserId() ?? null;
	const userIdRef = useRef(sessionUserId);
	userIdRef.current = sessionUserId;
	const url = node.url;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;

	useEffect(() => {
		if (!isMainWindow()) {
			return;
		}
		const controller = new AbortController();
		streamNavigationRequests(
			{ url, token, userJwt },
			(request) =>
				consumeNavigationRequest(request, userIdRef.current, openTab),
			controller.signal
		).catch(() => undefined);
		return () => controller.abort();
	}, [openTab, token, url, userJwt]);
}
