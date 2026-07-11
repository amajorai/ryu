/* @jsxImportSource @opentui/react */
// Tools tab - parity with apps/cli's Tools feature tab (main.rs refresh_feature_tab).
// Lists discoverable MCP tools (name / id title, description subtitle, kind badge)
// from /api/tools/search. Browse-only in apps/cli: there is no Enter/'a' action wired
// in feature_tab_action/secondary, so this tab only lists.

import { featureListLoader } from "../core/featureList.ts";
import { ListTab } from "../ui/ListTab.tsx";
import type { TabProps } from "./types.ts";

const loadTools = featureListLoader({
	path: "/api/tools/search?limit=30",
	containerKeys: ["data", "tools", "results"],
	titleKeys: ["name", "id"],
	subtitleKeys: ["description"],
	badgeKeys: ["kind"],
	idKeys: ["id"],
});

export function ToolsTab({ active }: TabProps) {
	return <ListTab active={active} emptyLabel="No tools" load={loadTools} />;
}
