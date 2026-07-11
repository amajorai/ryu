/* @jsxImportSource @opentui/react */
// Meetings surface (/meetings) - the desktop Meetings page, terminal edition.
// The desktop MeetingsPage is a record-start / detail screen with the meeting list
// in the sidebar; the terminal cannot capture audio, so this surface presents the
// meeting-notes LIST (title / created_at-status subtitle / status badge from
// /api/meetings). Ported from the legacy src/tabs/meetings.tsx so the new shell
// does not depend on src/tabs; the reused fetch is the generic featureListLoader.
// Browse-only: no Enter/'a' action (meetings are recorded from the desktop app).
//
// Contract adaptation: ListTab loads and gates its keyboard on its `active` prop,
// so we pass `focused = active && focusedPaneId === paneId` - the surface only
// drives the list while its pane owns the keyboard.

import { useTheme } from "@/components/ui/theme-provider.tsx";
import { featureListLoader } from "../../core/featureList.ts";
import { ListTab } from "../../ui/ListTab.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

const loadMeetings = featureListLoader({
	path: "/api/meetings",
	containerKeys: ["meetings", "data"],
	titleKeys: ["title", "name", "id"],
	subtitleKeys: ["created_at", "status"],
	badgeKeys: ["status"],
	idKeys: ["id"],
});

function MeetingsSurface({ active, paneId }: SurfaceProps) {
	const theme = useTheme();
	const { focusedPaneId } = useWorkspace();

	// Focused = this surface is the active tab AND its pane owns the keyboard.
	const focused = active && focusedPaneId === paneId;

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<box flexDirection="row" gap={1}>
				<text fg={theme.colors.foreground}>
					<b>Meetings</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					↑↓ nav · r refresh · record from the desktop app
				</text>
			</box>
			<ListTab active={focused} emptyLabel="No meetings" load={loadMeetings} />
		</box>
	);
}

/** The Meetings surface module. Registered by src/workspace/router.ts (path
 * /meetings). */
export const meetingsSurface: SurfaceModule = {
	id: "meetings",
	title: "Meetings",
	match: (path) => path === "/meetings" || path.startsWith("/meetings/"),
	Component: MeetingsSurface,
};
