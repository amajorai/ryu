import { SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { WorkbenchItem } from "@ryu/workbench/model";
import { TabGlyph } from "@/src/components/layout/TitleBar.tsx";
import { DockKindIcon } from "@/src/components/panels/WorkspacePanels.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { shellPanelKind } from "./shell-panels.ts";

function RouteItemIcon({ item, path }: { item: WorkbenchItem; path: string }) {
	const { tabs } = useTabsContext();
	const tab = tabs.find((candidate) => candidate.id === item.id);
	return (
		<TabGlyph
			busy={tab?.busy}
			busySpeed={tab?.busySpeed}
			className="size-3.5"
			icon={tab?.icon}
			logoSize="14px"
			path={tab?.path ?? path}
			unloaded={tab?.unloaded}
		/>
	);
}

/**
 * A workbench tab's glyph: a page shows the same glyph as its title bar tab
 * (including the busy spinner), a tool or app panel the one its dock tab had.
 */
export function WorkbenchItemIcon({ item }: { item: WorkbenchItem }) {
	switch (item.source.kind) {
		case "route":
			return <RouteItemIcon item={item} path={item.source.path} />;
		case "navigation":
			return <HugeiconsIcon icon={SidebarLeftIcon} />;
		default: {
			const kind = shellPanelKind(item);
			return kind ? <DockKindIcon kind={kind} /> : null;
		}
	}
}

/** Stable render callback for the workbench chrome. */
export function renderWorkbenchItemIcon(item: WorkbenchItem) {
	return <WorkbenchItemIcon item={item} />;
}
