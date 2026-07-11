/* @jsxImportSource @opentui/react */
// Teams tab - parity with apps/cli's Teams feature tab (main.rs refresh_feature_tab).
// Lists agent teams (name / id title, coordination-description subtitle, members count
// badge) from /api/teams. Browse-only in apps/cli: no Enter/'a' action is wired in
// feature_tab_action/secondary (team routing happens from the Chat tab's /team
// command), so this tab only lists.

import { featureListLoader } from "../core/featureList.ts";
import { ListTab } from "../ui/ListTab.tsx";
import type { TabProps } from "./types.ts";

const loadTeams = featureListLoader({
	path: "/api/teams",
	containerKeys: ["teams", "data"],
	titleKeys: ["name", "id"],
	subtitleKeys: ["coordination", "description"],
	badgeKeys: ["members"],
	idKeys: ["id"],
});

export function TeamsTab({ active }: TabProps) {
	return <ListTab active={active} emptyLabel="No teams" load={loadTeams} />;
}
