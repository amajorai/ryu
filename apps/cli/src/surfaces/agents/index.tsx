/* @jsxImportSource @opentui/react */
// Agents surface - the desktop-mirrored /agents page. It regroups the legacy
// src/tabs/agents.tsx master-detail content into the desktop AgentsPage
// information architecture (a titled page with a list + detail, plus New/Edit
// affordances) and adds an inline edit view that echoes the desktop
// /agents/:id/edit route: pressing `e` (or `n` for a new agent) opens that path
// via useWorkspace().openTab, and this same surface renders the edit form because
// its match() owns the /agents/ prefix.
//
// Data/fetch logic is reused unchanged from the legacy tab and the typed
// @ryuhq/core-client/agents module (fetchAgents / fetchAgent / createAgent /
// updateAgent). No new fetch paths are introduced.

import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";
import { AgentEditView } from "./index-edit.tsx";
import { AgentsListView } from "./index-list.tsx";

const AGENT_EDIT_RE = /^\/agents\/([^/]+)\/edit$/;

/** Extract the agent id from an edit path (`/agents/:id/edit`), or null when the
 * path is the plain list route. `new` is a valid sentinel meaning "create". */
function parseEditId(path: string): string | null {
	const match = AGENT_EDIT_RE.exec(path);
	return match?.[1] ?? null;
}

function AgentsSurface({ active, paneId }: SurfaceProps) {
	const { focusedPaneId, tabs, panes, openTab, closeTab } = useWorkspace();
	const focused = active && focusedPaneId === paneId;

	// Derive this instance's path from the pane's active tab, so one surface can
	// render either the list route or the /agents/:id/edit route.
	const pane = panes.find((p) => p.id === paneId);
	const activeTab = tabs.find((t) => t.id === pane?.activeTabId);
	const path = activeTab?.path ?? "/agents";
	const editId = parseEditId(path);

	if (editId !== null) {
		return (
			<AgentEditView
				agentId={editId}
				focused={focused}
				onClose={() => {
					openTab("/agents");
					if (activeTab) {
						closeTab(activeTab.id);
					}
				}}
			/>
		);
	}

	return (
		<AgentsListView
			focused={focused}
			onEdit={(agent) =>
				openTab(`/agents/${agent.id}/edit`, { title: agent.name })
			}
			onNew={() => openTab("/agents/new/edit", { title: "New agent" })}
		/>
	);
}

/** The Agents surface module. Owns the /agents list route and the
 * /agents/:id/edit route (including /agents/new/edit). */
export const agentsSurface: SurfaceModule = {
	id: "agents",
	title: "Agents",
	match: (path) => path === "/agents" || path.startsWith("/agents/"),
	Component: AgentsSurface,
};
