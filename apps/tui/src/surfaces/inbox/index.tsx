/* @jsxImportSource @opentui/react */
// Inbox surface (path /inbox) - fixes a dead nav link. The sidebar footer
// (NavUser) and the palette both open /inbox, but no surface rendered it, so it
// dead-ended at SplitView's "No surface registered". This is NOT an apps/cli
// parity gap (the CLI has no Inbox tab); it is a TUI-side broken stub. The fix is
// a light read-only list of the human-in-the-loop approval queue
// (GET /api/approvals?status=pending, the desktop Approvals inbox backend), reusing
// the shared featureListLoader/ListTab primitives. Decisions (approve/reject) are
// intentionally left to the desktop/web surfaces - this only surfaces the queue so
// the link no longer dead-ends.

import { useTheme } from "@/components/ui/theme-provider.tsx";
import { featureListLoader } from "../../core/featureList.ts";
import { ListTab } from "../../ui/ListTab.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

const loadApprovals = featureListLoader({
	path: "/api/approvals?status=pending",
	containerKeys: ["approvals", "data"],
	titleKeys: ["title", "summary", "kind", "id"],
	subtitleKeys: ["description", "detail", "kind"],
	badgeKeys: ["status", "kind"],
	idKeys: ["id"],
});

function InboxSurface({ active, paneId }: SurfaceProps) {
	const theme = useTheme();
	const { focusedPaneId } = useWorkspace();
	const focused = active && focusedPaneId === paneId;

	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.foreground}>
					<b>Inbox</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					Pending approvals · decide from the desktop app · r reload
				</text>
			</box>
			<ListTab
				active={focused}
				emptyLabel="Nothing waiting for approval"
				load={loadApprovals}
			/>
		</box>
	);
}

/** The Inbox surface module (path /inbox). Registered in workspace/router.ts. */
export const inboxSurface: SurfaceModule = {
	id: "inbox",
	title: "Inbox",
	match: (path) => path === "/inbox" || path.startsWith("/inbox/"),
	Component: InboxSurface,
};
