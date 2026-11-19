/* @jsxImportSource @opentui/react */
// Monitors surface - the desktop-mirrored /monitors page.
//
// The screen PREFERS the monitors app's own declarative view: if an enabled plugin
// contributes a `views` entry with id "surface:monitors" it claims this surface, and
// the shell renders that spec (src/ui/ContributedView.tsx) instead of the built-in
// list below. Until such a contribution exists the hand-written screen stays: it
// reuses
// the legacy src/tabs/monitors.tsx content (a list of website monitors from
// GET /api/monitors with Enter running the selected monitor's check now via
// POST /api/monitors/:id/run) rendered through the shared ListTab, reframed in the
// desktop MonitorsPage information architecture with a titled page header. The list
// + run fetch logic is reused unchanged (featureListLoader + runMonitor); no new
// fetch paths are introduced.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { runMonitor } from "@ryuhq/core-client/monitors";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useSurfaceView } from "../../core/ContributionsContext.tsx";
import { featureListLoader, type ListRow } from "../../core/featureList.ts";
import { ContributedViewPanel } from "../../ui/ContributedView.tsx";
import { ListTab } from "../../ui/ListTab.tsx";
import { checkedNotice } from "../../ui/list-notices.ts";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

// The surface id — and therefore the `views` id an app declares to claim this
// screen, as the reserved `surface:<id>` token (see viewClaimingSurface in
// src/core/contributions.ts).
const SURFACE_ID = "monitors";

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
	return checkedNotice(row.id);
};

function MonitorsSurface({ active, paneId }: SurfaceProps) {
	const { focusedPaneId } = useWorkspace();
	const theme = useTheme();
	const focused = active && focusedPaneId === paneId;
	const contributed = useSurfaceView(SURFACE_ID);

	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.foreground}>
					<b>Monitors</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					Website monitors on this node
				</text>
				{contributed ? null : (
					<text fg={theme.colors.mutedForeground}>
						Enter check now · j/k move · r reload
					</text>
				)}
			</box>
			{contributed ? (
				<box flexDirection="column" paddingLeft={1}>
					<ContributedViewPanel focused={focused} view={contributed} />
				</box>
			) : (
				<ListTab
					active={focused}
					emptyLabel="No monitors"
					load={loadMonitors}
					onActivate={checkMonitor}
				/>
			)}
		</box>
	);
}

/** The Monitors surface module (path /monitors). */
export const monitorsSurface: SurfaceModule = {
	id: SURFACE_ID,
	title: "Monitors",
	match: (path) => path === "/monitors" || path.startsWith("/monitors/"),
	Component: MonitorsSurface,
};
