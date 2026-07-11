// THE TAB REGISTRY - the single intentional barrel in this app.
//
// The shell renders the active tab by looking it up here. Order matches apps/cli's
// SIDEBAR_TABS (apps/cli/src/app.rs) so the sidebar and digit-jump (1-9) line up
// with the Rust TUI. Today only Chat is real; the other 16 use makePlaceholder.
//
// ── INTEGRATION (how to wire a new tab) ──────────────────────────────────────
// A tab builder creates src/tabs/<id>.tsx exporting a component that satisfies
// TabProps (see types.ts). They DO NOT touch this file. The integration step then:
//   1. import { AgentsTab } from "./agents.tsx";
//   2. replace that tab's `Component: makePlaceholder("Agents")` with
//      `Component: AgentsTab`.
// Nothing else changes - id/title/hotkey/order stay as defined below. Keep this
// file the ONLY place tabs are registered; do not add a second registry.

import { AccountTab } from "./account.tsx";
import { AgentsTab } from "./agents.tsx";
import { AppsTab } from "./apps.tsx";
import { ChatTab } from "./chat.tsx";
import { EnginesTab } from "./engines.tsx";
import { GatewayTab } from "./gateway.tsx";
import { MeetingsTab } from "./meetings.tsx";
import { ModelsTab } from "./models.tsx";
import { MonitorsTab } from "./monitors.tsx";
import { RecipesTab } from "./recipes.tsx";
import { SchedulesTab } from "./schedules.tsx";
import { ServicesTab } from "./services.tsx";
import { SkillsTab } from "./skills.tsx";
import { SpacesTab } from "./spaces.tsx";
import { TeamsTab } from "./teams.tsx";
import { ToolsTab } from "./tools.tsx";
import type { TabModule } from "./types.ts";
import { WorkflowsTab } from "./workflows.tsx";

export const TABS: TabModule[] = [
	{ id: "chat", title: "Chat", hotkey: "c", Component: ChatTab },
	{
		id: "services",
		title: "Services",
		hotkey: "s",
		Component: ServicesTab,
	},
	{
		id: "agents",
		title: "Agents",
		hotkey: "a",
		Component: AgentsTab,
	},
	{
		id: "models",
		title: "Models",
		hotkey: "m",
		Component: ModelsTab,
	},
	{
		id: "skills",
		title: "Skills",
		hotkey: "k",
		Component: SkillsTab,
	},
	{
		id: "tools",
		title: "Tools",
		hotkey: "t",
		Component: ToolsTab,
	},
	{
		id: "apps",
		title: "Apps",
		hotkey: "p",
		Component: AppsTab,
	},
	{
		id: "gateway",
		title: "Gateway",
		hotkey: "g",
		Component: GatewayTab,
	},
	{
		id: "workflows",
		title: "Workflows",
		hotkey: "w",
		Component: WorkflowsTab,
	},
	{
		id: "recipes",
		title: "Recipes",
		hotkey: "r",
		Component: RecipesTab,
	},
	{
		id: "teams",
		title: "Teams",
		hotkey: "e",
		Component: TeamsTab,
	},
	{
		id: "spaces",
		title: "Spaces",
		hotkey: "x",
		Component: SpacesTab,
	},
	{
		id: "engines",
		title: "Engines",
		hotkey: "n",
		Component: EnginesTab,
	},
	{
		id: "monitors",
		title: "Monitors",
		hotkey: "o",
		Component: MonitorsTab,
	},
	{
		id: "meetings",
		title: "Meetings",
		hotkey: "i",
		Component: MeetingsTab,
	},
	{
		id: "schedules",
		title: "Schedules",
		hotkey: "h",
		Component: SchedulesTab,
	},
	{
		id: "account",
		title: "Account",
		hotkey: "u",
		Component: AccountTab,
	},
];

/** Look up a tab module by id. */
export function tabById(id: string): TabModule | undefined {
	return TABS.find((tab) => tab.id === id);
}
