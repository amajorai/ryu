/* @jsxImportSource @opentui/react */
// Teams surface (path /teams) - the desktop-mirrored teams browser and the fix
// for the one broken interactive parity gap vs apps/cli. The component TeamsTab
// was already built (src/tabs/teams.tsx: a browse-only list of agent teams from
// GET /api/teams, matching apps/cli's Teams feature tab) but had NO surface
// registered, so every sidebar team item + PATH_TITLES["/teams"] dead-ended at
// SplitView's "No surface registered for /teams". This module registers it.
//
// Browse-only, exactly like apps/cli: no Enter/'a' action is wired (team routing
// happens from the Chat surface's /team command), so it only lists. It reuses the
// legacy TeamsTab content unchanged, reframed with the standard titled page header
// used by the other list surfaces (Monitors/Meetings/...).

import { useTheme } from "@/components/ui/theme-provider.tsx";
import { TeamsTab } from "../../tabs/teams.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

function TeamsSurface({ active, paneId }: SurfaceProps) {
	const theme = useTheme();
	const { focusedPaneId } = useWorkspace();
	const focused = active && focusedPaneId === paneId;

	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.foreground}>
					<b>Teams</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					Agent teams on this node · route one with /team in chat
				</text>
				<text fg={theme.colors.mutedForeground}>j/k move · r reload</text>
			</box>
			<TeamsTab active={focused} />
		</box>
	);
}

/** The Teams surface module (path /teams). Registered in workspace/router.ts. */
export const teamsSurface: SurfaceModule = {
	id: "teams",
	title: "Teams",
	match: (path) => path === "/teams" || path.startsWith("/teams/"),
	Component: TeamsSurface,
};
