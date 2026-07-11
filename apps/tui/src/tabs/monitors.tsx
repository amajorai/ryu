/* @jsxImportSource @opentui/react */
// Monitors tab - parity with apps/cli's Monitors feature tab (main.rs
// refresh_feature_tab + feature_tab_action). Lists website monitors (name / id title,
// url subtitle, last_status-enabled badge) from /api/monitors. Enter runs the
// selected monitor's check now (POST /api/monitors/:id/run). No secondary action.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { runMonitor } from "@ryuhq/core-client/monitors";
import { featureListLoader, type ListRow } from "../core/featureList.ts";
import { ListTab } from "../ui/ListTab.tsx";
import type { TabProps } from "./types.ts";

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

export function MonitorsTab({ active }: TabProps) {
	return (
		<ListTab
			active={active}
			emptyLabel="No monitors"
			load={loadMonitors}
			onActivate={checkMonitor}
		/>
	);
}
