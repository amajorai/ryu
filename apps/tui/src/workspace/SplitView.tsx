/* @jsxImportSource @opentui/react */
// SplitView - the center content region. Renders one pane full-width, or two
// panes side by side after splitActive(). Each pane shows the surface for its
// active tab (resolved from the router) with a focus-highlighted border; only the
// focused pane's surface receives keyboard (surfaces gate on
// useWorkspace().focusedPaneId === paneId, see SurfaceProps).

import { useTheme } from "@/components/ui/theme-provider.tsx";
import { resolveSurface } from "./router.ts";
import { type Pane, useWorkspace } from "./WorkspaceContext.tsx";

export function SplitView() {
	const { panes } = useWorkspace();
	return (
		<box flexDirection="row" flexGrow={1}>
			{panes.map((pane) => (
				<PaneView key={pane.id} pane={pane} />
			))}
		</box>
	);
}

function PaneView({ pane }: { pane: Pane }) {
	const theme = useTheme();
	const { tabs, focusedPaneId } = useWorkspace();
	const focused = pane.id === focusedPaneId;
	const activeTab = tabs.find((tab) => tab.id === pane.activeTabId);
	const surface = activeTab ? resolveSurface(activeTab.path) : undefined;

	return (
		<box
			borderColor={focused ? theme.colors.focusRing : theme.colors.border}
			borderStyle="rounded"
			flexDirection="column"
			flexGrow={1}
		>
			{surface && activeTab ? (
				<surface.Component active={true} paneId={pane.id} />
			) : (
				<box flexGrow={1} paddingLeft={1} paddingTop={1}>
					<text fg={theme.colors.mutedForeground}>
						{activeTab
							? `No surface registered for ${activeTab.path}`
							: "No open tab"}
					</text>
				</box>
			)}
		</box>
	);
}
