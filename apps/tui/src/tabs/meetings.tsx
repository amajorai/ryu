/* @jsxImportSource @opentui/react */
// Meetings tab - parity with apps/cli's Meetings feature tab (main.rs
// refresh_feature_tab). Lists meeting notes (title / name / id title, created_at-status
// subtitle, status badge) from /api/meetings. Browse-only in apps/cli: no Enter/'a'
// action is wired in feature_tab_action/secondary, so this tab only lists.

import { featureListLoader } from "../core/featureList.ts";
import { ListTab } from "../ui/ListTab.tsx";
import type { TabProps } from "./types.ts";

const loadMeetings = featureListLoader({
	path: "/api/meetings",
	containerKeys: ["meetings", "data"],
	titleKeys: ["title", "name", "id"],
	subtitleKeys: ["created_at", "status"],
	badgeKeys: ["status"],
	idKeys: ["id"],
});

export function MeetingsTab({ active }: TabProps) {
	return (
		<ListTab active={active} emptyLabel="No meetings" load={loadMeetings} />
	);
}
