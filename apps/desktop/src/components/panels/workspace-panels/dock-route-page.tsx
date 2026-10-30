import { type ReactNode, useMemo } from "react";
import {
	type DockTabKind,
	isDockableRoutePath,
	routeTabPath,
} from "@/src/components/panels/dock-panels.ts";
import {
	CurrentTabIdProvider,
	IsActiveTabProvider,
	TabsStateProvider,
	useCurrentTabId,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { TitleBarProvider } from "@/src/contexts/TitleBarContext.tsx";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";
import { DockPanelPlaceholder } from "./native-dock-panels.tsx";
import { DockRouteHostContext } from "./tab-model.ts";

/**
 * A main-tab PAGE hosted in a dock: the same `RouteOutlet` a window tab renders,
 * given a synthetic tab record.
 *
 * Three providers wrap it, and each one closes a specific way a dock-hosted page
 * would otherwise reach out and rewrite the WINDOW tab hosting it:
 *
 *   - `DockRouteHostContext` — read by {@link WorkspacePanels}, which renders
 *     bare children inside one. `/chat` is a hostable page, and ChatPage's root
 *     IS a `WorkspacePanels`; without this the dock would mount a dock inside
 *     itself, forever. A chat in the panel therefore shows the conversation with
 *     no docks of its own, which is also the right shape for a side panel.
 *   - `IsActiveTabProvider isActive={false}` — `useTitleBar` (TitleBarContext)
 *     writes the page's title into the titlebar AND into the tab strip's label,
 *     gated on exactly this flag. A page in the panel is not what the window tab
 *     is showing, so it must not rename it. Same for the assistant's page-context
 *     hooks and ChatPage's "mirror my conversation into the sidebar highlight".
 *   - `CurrentTabIdProvider` with the dock tab's own uid — ChatPage writes its
 *     conversation id and busy flag back to `useCurrentTabId()`. Pointed at the
 *     host window tab that would clobber the host chat's binding (a dedup match
 *     landing on the wrong thread, per `tab-conversation.ts`); pointed at a uid no
 *     window tab has, both writes are no-ops by construction.
 *
 * `TitleBarProvider` is nested for the same reason as the second bullet — belt
 * and braces, so a page that pushes titlebar actions writes into a throwaway
 * store rather than the shell's.
 */
export function DockRoutePage({
	kind,
	label,
	uid,
}: {
	kind: DockTabKind;
	label: string;
	uid: string;
}) {
	const path = routeTabPath(kind);
	const routeTab = useMemo(
		() => ({ id: uid, path, title: label }),
		[uid, path, label]
	);
	if (!isDockableRoutePath(path)) {
		return (
			<DockPanelPlaceholder text="This page can't be opened in a panel." />
		);
	}
	return (
		<DockPageBoundary uid={uid}>
			<div className="h-full min-h-0 overflow-auto">
				<RouteOutlet onClose={() => undefined} tab={routeTab} />
			</div>
		</DockPageBoundary>
	);
}

/** Reuse the dock host isolation when a permanent app embeds the existing chat page. */
export function DockPageBoundary({
	uid,
	children,
}: {
	uid: string;
	children: ReactNode;
}) {
	const parentTabs = useTabsContext();
	const parentTabId = useCurrentTabId();
	// Neuter every verb that MUTATES AN EXISTING TAB, at one seam, for the whole
	// subtree.
	//
	// Pointing `useCurrentTabId` at a uid no window tab has is enough for the
	// id-keyed writers (`bindTabConversation`, `updateTabBusy`, `updateTabTitle`),
	// but `updateTabsIconWhere` takes a PREDICATE — no tab id is involved, so it
	// patches every open tab that matches. Two pages reachable from this dock call
	// it: `SpaceDocEditorPage` (on a doc's own path) and `PluginHostPanel` (on an
	// app's, e.g. the Inbox), so a page shown in the side panel would rewrite the
	// glyphs of real window tabs. Overriding the context is what makes the fix
	// total rather than a list of pages someone has to keep updating — a page
	// added later inherits the guard.
	//
	// NAVIGATION is deliberately left intact: clicking a doc inside a dock-hosted
	// Library should still open it as a window tab, which is what `openTab` does.
	const scopedTabs = useMemo(
		() => ({
			...parentTabs,
			activeTabId: parentTabId ?? parentTabs.activeTabId,
			bindTabConversation: () => undefined,
			updateTabBusy: () => undefined,
			updateTabIcon: () => undefined,
			updateTabsIconWhere: () => undefined,
			updateTabTitle: () => undefined,
		}),
		[parentTabs, parentTabId]
	);
	return (
		<DockRouteHostContext.Provider value={true}>
			{/* Scope both direct context consumers and selector subscribers so the
			    embedded page cannot mutate its containing window tab. */}
			<TabsStateProvider value={scopedTabs}>
				<CurrentTabIdProvider tabId={uid}>
					<IsActiveTabProvider isActive={false}>
						<TitleBarProvider>{children}</TitleBarProvider>
					</IsActiveTabProvider>
				</CurrentTabIdProvider>
			</TabsStateProvider>
		</DockRouteHostContext.Provider>
	);
}
