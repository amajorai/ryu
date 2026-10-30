import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	Delete02Icon,
	SidebarRightIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useI18n } from "@ryu/i18n/react";
import {
	ContextMenuItem,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { openTabWindow } from "@/lib/tauri-bridge.ts";
import { isDockableRoutePath } from "@/src/components/panels/dock-panels.ts";
import { useOptionalChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { conversationEntityKey } from "@/src/lib/window-routing.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { useSidePanelRouteStore } from "@/src/store/useSidePanelRouteStore.ts";
import { useOptionalDesktopWorkbench } from "@/src/workbench/DesktopWorkbenchContext.tsx";

/** Pointer/focus handler for a tab chip: an unloaded chat tab remounts cold and
 * refetches its history when activated, so start that fetch as soon as the
 * pointer reaches the chip. */
export function useColdChatTabPrefetch(tab: Tab): () => void {
	const prefetchConversation =
		useOptionalChatHistoryContext()?.prefetchConversation;
	return () => {
		if (tab.unloaded && tab.path === "/chat" && tab.conversationId) {
			prefetchConversation?.(tab.conversationId);
		}
	};
}

/**
 * "Open in side panel" — show what this tab is showing in the workspace's right
 * dock instead of (or as well as) a window tab.
 *
 * The dock lives inside the chat surface, so the page lands in the focused chat's
 * right panel; when the current tab is not a chat, the request is held until a
 * chat tab is next focused rather than being dropped.
 *
 * This is the USER-initiated half of the seam and so passes a raw path
 * (`openPath`); the system-/agent-facing half selects a page KEY from the shared
 * allowlist instead — see `useSidePanelRouteStore`.
 */
export function OpenInSidePanelItem({ tab }: { tab: Tab }) {
	const { t } = useI18n();
	const openPath = useSidePanelRouteStore((s) => s.openPath);
	const tabs = useTabSelector((state) => state.tabs);
	const activeTabId = useTabSelector((state) => state.activeTabId);
	if (!isDockableRoutePath(tab.path)) {
		return null;
	}
	// The dock lives inside the chat surface, so a request raised from a non-chat
	// tab is HELD until a chat tab is next focused. Held is the right behaviour
	// (better than dropping it), but silently held is not: the click would look
	// dead now and produce a page appearing from nowhere later. Say where it went.
	const focused = tabs.find((t) => t.id === activeTabId);
	const dockIsLive = focused?.path.startsWith("/chat") ?? false;
	return (
		<ContextMenuItem
			onClick={() => {
				openPath(tab.path, tab.title);
				if (!dockIsLive) {
					toast.info(
						t(
							"shell.side-panel-queued",
							undefined,
							"Queued for the side panel"
						),
						{
							description: t(
								"shell.side-panel-queued-description",
								undefined,
								"It opens when you switch to a chat tab."
							),
						}
					);
				}
			}}
		>
			<HugeiconsIcon className="size-4" icon={SidebarRightIcon} />
			Open in side panel
		</ContextMenuItem>
	);
}

// Bulk-close helpers exclude pinned tabs — pinned tabs survive "close
// others/left/right" the way they do in Chrome.
export function bulkCloseItems(
	tab: Tab,
	tabs: Tab[],
	closeTab: (id: string) => void
) {
	const idx = tabs.findIndex((t) => t.id === tab.id);
	const others = tabs.filter((t) => t.id !== tab.id && !t.pinned);
	const toLeft = tabs.slice(0, idx).filter((t) => !t.pinned);
	const toRight = tabs.slice(idx + 1).filter((t) => !t.pinned);
	return (
		<>
			<ContextMenuItem
				disabled={others.length === 0}
				onClick={() => {
					for (const t of others) {
						closeTab(t.id);
					}
				}}
			>
				<HugeiconsIcon className="size-4" icon={Delete02Icon} />
				Close other tabs
			</ContextMenuItem>
			<ContextMenuItem
				disabled={toLeft.length === 0}
				onClick={() => {
					for (const t of toLeft) {
						closeTab(t.id);
					}
				}}
			>
				<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				Close tabs to the left
			</ContextMenuItem>
			<ContextMenuItem
				disabled={toRight.length === 0}
				onClick={() => {
					for (const t of toRight) {
						closeTab(t.id);
					}
				}}
			>
				<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
				Close tabs to the right
			</ContextMenuItem>
		</>
	);
}

// Open a tab in its own OS window. The conversation lives server-side, so the
// spawned window re-fetches it by id; we carry the tab's node binding so a
// remote-targeted chat keeps its node. This is intentionally a non-destructive
// copy: a native window can be constructed before its renderer is ready, so a
// true move must wait for a destination-ready handshake (the future drag-out
// path) before closing the source tab.
export async function openTabInNewWindow(tab: Tab) {
	const overrideName = useNodeStore.getState().tabOverrides[tab.id];
	try {
		await openTabWindow({
			entityKey: tab.conversationId
				? conversationEntityKey(tab.conversationId)
				: undefined,
			path: tab.path,
			conversationId: tab.conversationId,
			node: overrideName,
			title: tab.title,
		});
	} catch {
		// Window creation failed — the source tab remains the owner.
	}
}

export function MoveTabToRegionMenu({ tabId }: { tabId: string }) {
	const workbench = useOptionalDesktopWorkbench();
	if (!workbench) {
		return null;
	}
	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>Move to pane</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				{(["center", "right", "bottom"] as const).map((region) => (
					<ContextMenuItem
						key={region}
						onClick={() => {
							workbench.dispatch({ type: "region/show", region });
							workbench.moveItem(tabId, { region });
						}}
					>
						{region === "center"
							? "Center"
							: region === "right"
								? "Right"
								: "Bottom"}
					</ContextMenuItem>
				))}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}
