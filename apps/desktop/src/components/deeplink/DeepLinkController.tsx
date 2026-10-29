import { completeComposioConnection } from "@ryuhq/core-client/composio.ts";
import {
	normalizeRnpNodeUrl,
	resolveRnpNode,
} from "@ryuhq/protocol/continuity";
import {
	type DeepLinkIntent,
	isRyuDeepLinkProfile,
	parseConnectCallbackDeepLink,
	parseRyuDeepLink,
	ryuDeepLinkProfile,
} from "@ryuhq/protocol/deep-link";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import { ContinueOnNodeDialog } from "@/src/components/chat/ContinueOnNodeDialog.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { request as coreRequest, toTarget } from "@/src/lib/api/client.ts";
import { pageRoute } from "@/src/lib/page-routes.ts";
import { isMainWindow } from "@/src/lib/window-routing.ts";
import { useDeepLinkStore } from "@/src/store/useDeepLinkStore.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { ConnectCallbackDialog } from "./ConnectCallbackDialog.tsx";
import { DeepLinkConfirmDialog } from "./DeepLinkConfirmDialog.tsx";

type OpenTab = ReturnType<typeof useTabsContext>["openTab"];
type HandoffIntent = Extract<DeepLinkIntent, { kind: "handoff" }>;

interface PendingHandoff {
	intent: HandoffIntent;
	/** Node list snapshot taken when the link was accepted. Node-store refreshes
	 * (window focus, token refresh) must not reset the reviewed handoff; the
	 * dialog re-reads live nodes through `resolveNodes` when continuing. */
	nodes: Node[];
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
	if (intent.kind === "plugin-app") {
		openTab(
			`/plugin/${encodeURIComponent(`mcp__${intent.pluginId}.${intent.toolName}`)}`,
			{ mountContext: { appPath: intent.appPath } }
		);
		return true;
	}
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
	const queryClient = useQueryClient();
	const [pendingCallback, setPendingCallback] = useState<{
		sessionUri: string;
	} | null>(null);
	const { openTab } = useTabsContext();
	const request = useDeepLinkStore((s) => s.request);
	const nodes = useNodeStore((s) => s.nodes);
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

		const handle = async (urls: string[]) => {
			const build = await invoke<{
				profile: unknown;
				deepLinkProfile: unknown;
			}>("get_build_profile");
			if (
				cancelled ||
				!isRyuDeepLinkProfile(build.profile) ||
				build.deepLinkProfile !== build.profile
			) {
				return;
			}
			for (const url of urls) {
				if (ryuDeepLinkProfile(url) !== build.profile) {
					continue;
				}
				const callback = parseConnectCallbackDeepLink(url);
				if (callback) {
					setPendingCallback((current) => current ?? callback);
					continue;
				}
				const intent = parseRyuDeepLink(url);
				if (!intent) {
					continue;
				}
				if (intent.kind === "handoff") {
					const configuredNodes = useNodeStore.getState().nodes;
					const resolution = resolveRnpNode(
						intent.sourceNodeUrl,
						configuredNodes
					);
					if (resolution.kind === "blocked") {
						sileo.error({
							title: "Handoff source is not a configured node",
						});
						continue;
					}
					setPendingHandoff({
						intent,
						nodes: configuredNodes,
						sourceNode: resolution.node,
					});
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
				} else if (intent.kind === "bundle") {
					openTab("/marketplace");
				}
				request(intent);
			}
		};

		// Warm start: the running instance is handed the URL (single-instance
		// forwards it on Windows/Linux). Rejects harmlessly outside Tauri.
		onOpenUrl((urls) => {
			void handle(urls).catch(() => {
				/* Native profile unavailable: ignore the link. */
			});
		})
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
			.then(async (urls) => {
				if (urls) {
					await handle(urls);
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
			{pendingCallback ? (
				<ConnectCallbackDialog
					nodes={nodes}
					onClose={() => setPendingCallback(null)}
					onComplete={async (selected) => {
						const node = useNodeStore
							.getState()
							.nodes.find((node) => node.name === selected.name);
						const origin = normalizeRnpNodeUrl(selected.url);
						if (!(node && origin) || normalizeRnpNodeUrl(node.url) !== origin) {
							throw new Error("The selected node changed");
						}
						await completeComposioConnection(
							toTarget(node),
							pendingCallback.sessionUri,
							coreRequest
						);
						await queryClient.invalidateQueries({
							queryKey: ["composio", "connections", node.url],
						});
						// The callback may have completed an agent's own app instead.
						await queryClient.invalidateQueries({
							queryKey: ["composio", "agent-connections", node.url],
						});
					}}
				/>
			) : null}
			{pendingHandoff ? (
				<ContinueOnNodeDialog
					conversationId={pendingHandoff.intent.conversationId}
					conversationTitle="Shared conversation"
					nodes={pendingHandoff.nodes}
					onCompleted={(destination, _result, workspaceResult) => {
						// A resumed working tree is a handed-off worktree; Core refuses
						// to fork a managed worktree from it, so this tab runs Local.
						openTab("/chat", {
							conversationId: pendingHandoff.intent.conversationId,
							node: destination.name,
							worktreeMode: workspaceResult ? false : undefined,
						});
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
