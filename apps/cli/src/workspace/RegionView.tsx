/* @jsxImportSource @opentui/react */
// RegionView - the Right or Bottom region of the workbench: a one-line tab list
// naming the region (bold while it holds keyboard focus) above the active tab's
// surface. It renders nothing while the region is hidden or empty, so Center
// keeps the full width/height. Surfaces receive the region's group id as their
// pane id, so the same focus gating that splits use applies here.

import { useRenderer } from "@opentui/react";
import { Divider } from "@/components/ui/divider.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { tf } from "../i18n/translate.ts";
import { resolveSurface } from "./router.ts";
import { type SideRegion, useWorkspace } from "./WorkspaceContext.tsx";

const REGION_NAMES: Record<SideRegion, string> = {
	bottom: "Bottom",
	right: "Right",
};

/** Bottom takes about a third of the terminal, never less than 6 rows. */
function bottomHeight(rows: number): number {
	return Math.max(6, Math.floor(rows / 3));
}

export function RegionView({ region }: { region: SideRegion }) {
	const theme = useTheme();
	const renderer = useRenderer();
	const { focusedPaneId, regionGroups, tabs } = useWorkspace();
	const pane = regionGroups[region];
	if (!pane) {
		return null;
	}
	const focused = pane.id === focusedPaneId;
	const activeTab = tabs.find((tab) => tab.id === pane.activeTabId);
	const surface = activeTab ? resolveSurface(activeTab.path) : undefined;
	const borderColor = focused ? theme.colors.focusRing : theme.colors.border;
	const height = bottomHeight(renderer.height);

	const header = (
		<box flexDirection="row" flexShrink={0} gap={1} paddingLeft={1}>
			<text fg={focused ? theme.colors.primary : theme.colors.mutedForeground}>
				{focused ? <b>{REGION_NAMES[region]}</b> : REGION_NAMES[region]}
			</text>
			{pane.tabIds.map((tabId) => {
				const tab = tabs.find((candidate) => candidate.id === tabId);
				if (!tab) {
					return null;
				}
				const active = tab.id === pane.activeTabId;
				return (
					<text
						fg={active ? theme.colors.foreground : theme.colors.mutedForeground}
						key={tab.id}
					>
						{active ? <b>{tab.title}</b> : tab.title}
					</text>
				);
			})}
		</box>
	);
	const body =
		surface && activeTab ? (
			<surface.Component active={true} paneId={pane.id} />
		) : (
			<box flexGrow={1} paddingLeft={1}>
				<text fg={theme.colors.mutedForeground}>
					{activeTab
						? tf("No surface registered for {path}", { path: activeTab.path })
						: "No open tab"}
				</text>
			</box>
		);

	if (region === "bottom") {
		return (
			<box flexDirection="column" flexShrink={0} height={height}>
				<box flexShrink={0} height={1} overflow="hidden">
					<text fg={borderColor}>{"─".repeat(renderer.width)}</text>
				</box>
				{header}
				<box flexDirection="column" flexGrow={1}>
					{body}
				</box>
			</box>
		);
	}
	return (
		<box flexDirection="row" flexShrink={0} width="35%">
			<box flexShrink={0} marginRight={1}>
				<Divider
					color={borderColor}
					height={Math.max(1, renderer.height - 2)}
					orientation="vertical"
				/>
			</box>
			<box flexDirection="column" flexGrow={1}>
				{header}
				{body}
			</box>
		</box>
	);
}
