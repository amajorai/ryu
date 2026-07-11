/* @jsxImportSource @opentui/react */
// Monitors surface - the desktop-mirrored /monitors page. It reuses the legacy
// src/tabs/monitors.tsx content (a list of website monitors from GET /api/monitors
// with Enter running the selected monitor's check now via
// POST /api/monitors/:id/run) rendered through the shared ListTab, and reframes it
// in the desktop MonitorsPage information architecture with a titled page header.
// The list + run fetch logic is reused unchanged (featureListLoader + runMonitor);
// no new fetch paths are introduced.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { runMonitor } from "@ryuhq/core-client/monitors";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { featureListLoader, type ListRow } from "../../core/featureList.ts";
import { ListTab } from "../../ui/ListTab.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

const loadMonitors = featureListLoader({
	path: "/api/monitors",
	containerKeys: ["monitors", "data"],
	titleKeys: ["name", "id"],
	subtitleKeys: ["url"],
	badgeKeys: ["last_status", "enabled"],
	idKeys: ["id"],
});

const checkMonitor = async (
	row: ListRow,
	target: ApiTarget
): Promise<string> => {
	await runMonitor(target, row.id);
	return `checked: ${row.id}`;
};

function MonitorsSurface({ active, paneId }: SurfaceProps) {
	const { focusedPaneId } = useWorkspace();
	const theme = useTheme();
	const focused = active && focusedPaneId === paneId;

	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.foreground}>
					<b>Monitors</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					Website monitors on this node
				</text>
				<text fg={theme.colors.mutedForeground}>
					Enter check now · j/k move · r reload
				</text>
			</box>
			<ListTab
				active={focused}
				emptyLabel="No monitors"
				load={loadMonitors}
				onActivate={checkMonitor}
			/>
		</box>
	);
}

/** The Monitors surface module (path /monitors). */
export const monitorsSurface: SurfaceModule = {
	id: "monitors",
	title: "Monitors",
	match: (path) => path === "/monitors" || path.startsWith("/monitors/"),
	Component: MonitorsSurface,
};
