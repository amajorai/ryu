/* @jsxImportSource @opentui/react */
// Tools surface - the desktop-mirrored /tools page. It reuses the legacy
// src/tabs/tools.tsx content (a browse-only list of discoverable MCP tools from
// GET /api/tools/search, rendered via the shared ListTab) and reframes it in the
// desktop ToolsPage information architecture with a titled page header. The tool
// discovery fetch logic is reused unchanged through featureListLoader; no new
// fetch paths are introduced.

import { useTheme } from "@/components/ui/theme-provider.tsx";
import { featureListLoader } from "../../core/featureList.ts";
import { ListTab } from "../../ui/ListTab.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

const loadTools = featureListLoader({
	path: "/api/tools/search?limit=30",
	containerKeys: ["data", "tools", "results"],
	titleKeys: ["name", "id"],
	subtitleKeys: ["description"],
	badgeKeys: ["kind"],
	idKeys: ["id"],
});

function ToolsSurface({ active, paneId }: SurfaceProps) {
	const { focusedPaneId } = useWorkspace();
	const theme = useTheme();
	const focused = active && focusedPaneId === paneId;

	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.foreground}>
					<b>Tools</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					Discoverable MCP tools on this node
				</text>
				<text fg={theme.colors.mutedForeground}>j/k move · r reload</text>
			</box>
			<ListTab active={focused} emptyLabel="No tools" load={loadTools} />
		</box>
	);
}

/** The Tools surface module (path /tools). */
export const toolsSurface: SurfaceModule = {
	id: "tools",
	title: "Tools",
	match: (path) => path === "/tools" || path.startsWith("/tools/"),
	Component: ToolsSurface,
};
