/* @jsxImportSource @opentui/react */
// Downloads surface (path /downloads) - fixes a dead nav link. The sidebar footer
// (NavUser) opens /downloads, but no surface rendered it, so it dead-ended at
// SplitView's "No surface registered". Like Inbox this is NOT an apps/cli parity
// gap (the CLI has no Downloads tab); it is a TUI-side broken stub. The fix is a
// light read-only view of Core's global download center (GET /api/downloads, the
// #456 lifecycle), reusing the typed core-client listDownloads reader mapped to
// ListRow[] for the shared ListTab. Pause/resume/retry/cancel controls are left to
// the desktop download center - this only surfaces state so the link works.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { listDownloads } from "@ryuhq/core-client/downloads";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import type { ListRow } from "../../core/featureList.ts";
import { ListTab } from "../../ui/ListTab.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";
import { downloadKindLabel, progressBadge } from "./progress-badge.ts";

async function loadDownloads(target: ApiTarget): Promise<ListRow[]> {
	const tasks = await listDownloads(target);
	return tasks.map((task) => ({
		id: task.id,
		title: task.label || task.id,
		subtitle: task.error ?? downloadKindLabel(task.kind),
		badge: progressBadge(task),
	}));
}

function DownloadsSurface({ active, paneId }: SurfaceProps) {
	const theme = useTheme();
	const { focusedPaneId } = useWorkspace();
	const focused = active && focusedPaneId === paneId;

	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.foreground}>
					<b>Downloads</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					Model / engine / tool downloads on this node · r reload
				</text>
			</box>
			<ListTab
				active={focused}
				emptyLabel="No downloads"
				load={loadDownloads}
			/>
		</box>
	);
}

/** The Downloads surface module (path /downloads). Registered in router.ts. */
export const downloadsSurface: SurfaceModule = {
	id: "downloads",
	title: "Downloads",
	match: (path) => path === "/downloads" || path.startsWith("/downloads/"),
	Component: DownloadsSurface,
};
