import { cn } from "@ryu/ui/lib/utils.ts";
import type { WorkbenchItem } from "@ryu/workbench/model";
import { CrashBoundary } from "@/src/components/CrashBoundary.tsx";
import { TitlebarPage } from "@/src/components/layout/TitlebarPage.tsx";
import {
	CurrentTabIdProvider,
	IsActiveTabProvider,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { useTitleBarClearsContent } from "@/src/hooks/useTitleBarClearsContent.ts";
import { useDesktopWorkbench } from "./DesktopWorkbenchContext.tsx";

export function RouteWorkbenchItem({ item }: { item: WorkbenchItem }) {
	const { dispatch, state } = useDesktopWorkbench();
	const { closeTab, tabs } = useTabsContext();
	const titleBarClearsContent = useTitleBarClearsContent();
	const [sidebarVariant] = useSidebarVariant();
	if (item.source.kind !== "route") {
		return null;
	}

	const tab = tabs.find((candidate) => candidate.id === item.id);
	const group = state.groups.find((candidate) =>
		candidate.itemIds.includes(item.id)
	);
	if (!(tab && group) || tab.unloaded) {
		return null;
	}

	const focused =
		state.focusedGroupId === group.id && group.activeItemId === item.id;
	const needsClearance = group.region === "center" && titleBarClearsContent;

	return (
		<IsActiveTabProvider isActive={focused}>
			<CurrentTabIdProvider tabId={tab.id}>
				<div
					className={cn(
						"flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
						needsClearance && "relative"
					)}
					onMouseDownCapture={
						focused
							? undefined
							: () => dispatch({ type: "item/activate", itemId: item.id })
					}
				>
					<TitlebarPage
						inset={
							needsClearance ? (sidebarVariant === "floating" ? 80 : 72) : 0
						}
						selfInset={tab.path === "/chat" || tab.path.startsWith("/chat/")}
					>
						<CrashBoundary resetKeys={[tab.path, tab.navToken ?? 0]}>
							<RouteOutlet
								key={tab.navToken ?? 0}
								onClose={() => closeTab(tab.id)}
								tab={tab}
							/>
						</CrashBoundary>
					</TitlebarPage>
				</div>
			</CurrentTabIdProvider>
		</IsActiveTabProvider>
	);
}
