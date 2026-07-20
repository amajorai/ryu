import {
	type DeepLinkIntent,
	parseRyuDeepLink,
} from "@ryuhq/protocol/deep-link";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { useEffect } from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useDeepLinkStore } from "@/src/store/useDeepLinkStore.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { DeepLinkConfirmDialog } from "./DeepLinkConfirmDialog.tsx";

type OpenTab = ReturnType<typeof useTabsContext>["openTab"];

// Maps the surface-agnostic page keys (`ryu://open/<page>`) to desktop tab
// routes. An unknown key is ignored — a malicious or stale link can't navigate
// somewhere unexpected. "apps"/"plugins" share the plugins route.
const PAGE_ROUTES: Record<string, string> = {
	chat: "/chat",
	// Agents/Spaces/Workflows are consolidated into the unified Library; deep
	// links open the matching Library tab.
	agents: "/library/agent",
	models: "/models",
	skills: "/skills",
	tools: "/tools",
	spaces: "/library/space",
	workflows: "/library/workflow",
	// `automations` was merged into Workflows; keep the alias pointing at the
	// surviving surface so existing ryu://…automations deep links still resolve.
	automations: "/library/workflow",
	monitors: "/monitors",
	// Approvals live inside the unified Inbox; the /approvals route resolves there.
	approvals: "/approvals",
	marketplace: "/marketplace",
	settings: "/settings",
	timeline: "/timeline",
	fleet: "/fleet",
	extensions: "/extensions",
	apps: "/apps",
	plugins: "/apps",
	engines: "/engines",
	store: "/store",
	calendar: "/calendar",
};

// Only the main window handles deep links — tear-off ("tab-N") and companion
// windows also render Layout, and registering the listener in each would
// double-handle a single link.
function isMainWindow(): boolean {
	try {
		// biome-ignore lint/suspicious/noExplicitAny: Tauri internal metadata
		const internals = (window as any).__TAURI_INTERNALS__;
		return (internals?.metadata?.currentWindow?.label ?? "main") === "main";
	} catch {
		return true;
	}
}

/**
 * Act on a navigation intent (page or chat) by opening the right tab. Returns
 * true when the intent was navigation (no confirm needed); false for an action
 * intent (model/skill/node) that must go through the confirm dialog. Navigation
 * has no side effect — a chat prompt only PRE-SEEDS the composer, never sends.
 */
function navigateForIntent(intent: DeepLinkIntent, openTab: OpenTab): boolean {
	if (intent.kind === "page") {
		// Channels and Identities live inside the Gateway dialog; Credits lives in
		// App Settings → Services. These have no standalone route, so open the
		// relevant dialog at that section instead of navigating to a tab.
		if (intent.page === "channels") {
			useGatewayDialog.getState().openGateway("channels");
			return true;
		}
		if (intent.page === "identities") {
			useGatewayDialog.getState().openGateway("identities");
			return true;
		}
		if (intent.page === "credits") {
			useSettingsDialog.getState().openSettings("credits");
			return true;
		}
		const route = PAGE_ROUTES[intent.page];
		if (route) {
			openTab(route);
		}
		return true;
	}
	if (intent.kind === "chat") {
		if (intent.conversationId) {
			openTab("/chat", { conversationId: intent.conversationId });
		} else {
			openTab("/chat", {
				forceNew: true,
				title: "New chat",
				initialPrompt: intent.prompt ?? undefined,
				initialAgent: intent.agent ?? undefined,
				initialProject: intent.project ?? undefined,
			});
		}
		return true;
	}
	return false;
}

/**
 * Wires `ryu://` deep links into the app: listens for inbound URLs (warm start
 * via `onOpenUrl`, cold start via `getCurrent`), navigates for page/chat intents,
 * and for action intents opens the relevant catalog tab so the user lands in
 * context, then queues the intent for the confirm dialog. Mounted once inside
 * `TabsProvider` so it can call `openTab`.
 */
export function DeepLinkController() {
	const { openTab } = useTabsContext();
	const request = useDeepLinkStore((s) => s.request);

	useEffect(() => {
		if (!isMainWindow()) {
			return;
		}
		let unlisten: (() => void) | undefined;
		let cancelled = false;

		const handle = (urls: string[]) => {
			for (const url of urls) {
				const intent = parseRyuDeepLink(url);
				if (!intent) {
					continue;
				}
				// Navigation intents act immediately (no side effect). Action intents
				// open the relevant catalog tab for context, then route to the confirm
				// dialog — the security boundary before any install/connect.
				if (navigateForIntent(intent, openTab)) {
					continue;
				}
				if (intent.kind === "model") {
					openTab("/models");
				} else if (intent.kind === "skill") {
					openTab("/skills");
				}
				request(intent);
			}
		};

		// Warm start: the running instance is handed the URL (single-instance
		// forwards it on Windows/Linux). Rejects harmlessly outside Tauri.
		onOpenUrl((urls) => handle(urls))
			.then((u) => {
				if (cancelled) {
					u();
				} else {
					unlisten = u;
				}
			})
			.catch(() => {
				/* not in Tauri / plugin unavailable — ignore */
			});

		// Cold start: the app was launched by the link — replay the launch URL.
		getCurrent()
			.then((urls) => {
				if (urls) {
					handle(urls);
				}
			})
			.catch(() => {
				/* no launch URL / not in Tauri — ignore */
			});

		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [openTab, request]);

	return <DeepLinkConfirmDialog />;
}
