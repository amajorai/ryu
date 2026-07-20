// apps/desktop/src/components/layout/CreateMenu.tsx
//
// The sidebar-footer "+" create menu: a FloatingDisclosure whose actions spawn
// new entities. Chat / agent / workflow open straight into a tab; team and space
// need their shared create dialogs, so this component mounts them and toggles
// them from the matching action. Lives beside the inbox button in NavUser.

import {
	BubbleChatIcon,
	Folder01Icon,
	Target01Icon,
	UserGroupIcon,
	WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { CreateSpaceDialog } from "@/src/components/spaces/CreateSpaceDialog.tsx";
import {
	TeamDialog,
	type TeamDraft,
} from "@/src/components/teams/TeamDialog.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { useEntityCap } from "@/src/lib/gating/useEntityCap.ts";
import { FloatingDisclosure } from "../watermelon-ui/floating-disclosure.tsx";

export function CreateMenu() {
	// CreateMenu is always mounted in the sidebar footer, so calling the cap hook
	// here keeps the non-React planCapBridge singleton in sync with the resolved
	// entitlement — that is what lets the zustand `useNodeStore` enforce its remote-
	// node cap and open the same upgrade modal even when no other cap hook is up.
	useEntityCap();
	const { openTab } = useTabsContext();
	const { create: createTeam } = useTeams();
	const { agents } = useAgents();
	const { create: createSpace } = useSpacesContext();
	const [teamOpen, setTeamOpen] = useState(false);
	const [spaceOpen, setSpaceOpen] = useState(false);

	const handleCreateTeam = async (draft: TeamDraft) => {
		await createTeam(draft);
	};

	const items = [
		{
			icon: BubbleChatIcon,
			id: "chat",
			label: "New chat",
			description: "Start a fresh conversation",
			onSelect: () => openTab("/chat", { forceNew: true }),
		},
		{
			icon: Target01Icon,
			id: "agent",
			label: "New agent",
			description: "Build a custom agent",
			onSelect: () => openTab("/agents/new/edit", { title: "New agent" }),
		},
		{
			icon: UserGroupIcon,
			id: "team",
			label: "New team",
			description: "Group agents together",
			onSelect: () => setTeamOpen(true),
		},
		{
			icon: WorkflowSquare01Icon,
			id: "workflow",
			label: "New workflow",
			description: "Automate a sequence",
			onSelect: () => openTab("/workflows/new", { title: "New workflow" }),
		},
		{
			icon: WorkflowSquare01Icon,
			id: "workflow-build",
			label: "Build with AI",
			description: "Describe a workflow and let Ryu build it",
			onSelect: () =>
				openTab("/workflows/build", { title: "Build a workflow" }),
		},
		{
			icon: Folder01Icon,
			id: "space",
			label: "New space",
			description: "Organize your documents",
			onSelect: () => setSpaceOpen(true),
		},
	];

	return (
		<>
			<FloatingDisclosure items={items} label="Create new" />
			<TeamDialog
				agents={agents}
				onClose={() => setTeamOpen(false)}
				onSubmit={handleCreateTeam}
				open={teamOpen}
				team={null}
			/>
			<CreateSpaceDialog
				onClose={() => setSpaceOpen(false)}
				onCreate={createSpace}
				open={spaceOpen}
			/>
		</>
	);
}
