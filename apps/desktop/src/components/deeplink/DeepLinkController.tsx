import { resolveRnpNode } from "@ryuhq/protocol/continuity";
import {
	type DeepLinkIntent,
	parseRyuDeepLink,
} from "@ryuhq/protocol/deep-link";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import { ContinueOnNodeDialog } from "@/src/components/chat/ContinueOnNodeDialog.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { pageRoute } from "@/src/lib/page-routes.ts";
import { isMainWindow } from "@/src/lib/window-routing.ts";
import { useDeepLinkStore } from "@/src/store/useDeepLinkStore.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { DeepLinkConfirmDialog } from "./DeepLinkConfirmDialog.tsx";

type OpenTab = ReturnType<typeof useTabsContext>["openTab"];
type HandoffIntent = Extract<DeepLinkIntent, { kind: "handoff" }>;

interface PendingHandoff {
	intent: HandoffIntent;
	sourceNode: Node;
}

// The page-key → tab-route map (`ryu://open/<page>`) lives in
// `@/src/lib/page-routes.ts`: it is the allowlist BOTH this controller and the
// workspace dock's page seam (`useSidePanelRouteStore`) check against, and one
// copy is what keeps "reachable by deep link" and "openable in the side panel"
// the same set. An unknown key is ignored here exactly as before — a malicious or
// stale link can't navigate somewhere unexpected.

/**
 * Act on a navigation intent (page or chat) by opening the right tab. Returns
 * true when the intent was navigation (no confirm needed); false for an action
 * intent (model/skill/node) that must go through the confirm dialog. Navigation
 * has no side effect — a chat prompt only PRE-SEEDS the composer, never sends.
 */
function navigateForIntent(intent: DeepLinkIntent, openTab: OpenTab): boolean {
	if (intent.kind === "page") {
		// Credits lives in App Settings → Services (no standalone route).
		if (intent.page === "credits") {
			useSettingsDialog.getState().openSettings("credits");
			return true;
		}
		// Through `pageRoute`, not a bare index: an inbound link's page key is
		// attacker-controlled, and a raw lookup resolves `toString`/`constructor`
		// off the prototype to a truthy non-string.
		const route = pageRoute(intent.page);
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
	const nodes = useNodeStore((s) => s.nodes);
	const setTabNodeOverride = useNodeStore((s) => s.setTabOverride);
	const resolveConfiguredNodes = useCallback(
		() => useNodeStore.getState().nodes,
		[]
	);
	const [pendingHandoff, setPendingHandoff] = useState<PendingHandoff | null>(
		null
	);

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
				if (intent.kind === "handoff") {
					const resolution = resolveRnpNode(
						intent.sourceNodeUrl,
						useNodeStore.getState().nodes
					);
					if (resolution.kind === "blocked") {
						sileo.error({
							title: "Handoff source is not a configured node",
						});
						continue;
					}
					setPendingHandoff({ intent, sourceNode: resolution.node });
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
				} else if (intent.kind === "app") {
					openTab("/apps");
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

	return (
		<>
			<DeepLinkConfirmDialog />
			{pendingHandoff ? (
				<ContinueOnNodeDialog
					conversationId={pendingHandoff.intent.conversationId}
					conversationTitle="Shared conversation"
					nodes={nodes}
					onCompleted={(destination) => {
						const tabId = openTab("/chat", {
							conversationId: pendingHandoff.intent.conversationId,
						});
						setTabNodeOverride(tabId, destination.name);
						setPendingHandoff(null);
					}}
					onOpenChange={(open) => {
						if (!open) {
							setPendingHandoff(null);
						}
					}}
					open
					resolveNodes={resolveConfiguredNodes}
					sourceNode={pendingHandoff.sourceNode}
				/>
			) : null}
		</>
	);
}
