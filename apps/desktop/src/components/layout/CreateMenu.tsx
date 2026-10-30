// apps/desktop/src/components/layout/CreateMenu.tsx
//
// The "New" create submenu in the account menu. It used to be a "+" button in
// the sidebar footer that morphed into a panel of large rows; the footer now
// keeps to the avatar and the bell, so creating lives one click deeper, as an
// ordinary submenu with `h-8 text-sm` rows.
//
// Team, space and upload need their shared create dialogs. A dropdown unmounts
// its content on close, so the dialogs cannot live inside the menu: the footer
// wraps its account menu in `CreateMenuHost`, which owns the dialogs and hands
// the rows to `CreateSubmenu` through context (context crosses the menu portal).
// Surfaces without creation (menubar, Bot) simply don't mount the host, and the
// submenu then renders nothing.
//
// The list is NOT hardcoded. The built-ins below are kernel-owned; everything
// else comes from enabled apps through `useContributedCreateActions` — see that
// module for the contribution seam and its one gap.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { createContext, type ReactNode, use, useState } from "react";
import { AddToSpaceDialog } from "@/src/components/spaces/AddToSpaceDialog.tsx";
import { CreateSpaceDialog } from "@/src/components/spaces/LazyCreateSpaceDialog.tsx";
import {
	TeamDialog,
	type TeamDraft,
} from "@/src/components/teams/TeamDialog.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { useEntityCap } from "@/src/lib/gating/useEntityCap.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";
import {
	type CreateMenuAction,
	useContributedCreateActions,
} from "./contributed-create-actions.ts";

const CreateMenuItemsContext = createContext<CreateMenuAction[]>([]);

/** Owns the create dialogs and provides the "New" rows to `CreateSubmenu`. */
export function CreateMenuHost({ children }: { children: ReactNode }) {
	// The footer is always mounted in the sidebar, so calling the cap hook here
	// keeps the non-React planCapBridge singleton in sync with the resolved
	// entitlement — that is what lets the zustand `useNodeStore` enforce its remote-
	// node cap and open the same upgrade modal even when no other cap hook is up.
	useEntityCap();
	const openTab = useTabSelector((state) => state.openTab);
	const { openCreateAgent } = useCreateAgentDialog();
	const { create: createTeam } = useTeams();
	const { agents } = useAgents();
	const { create: createSpace } = useSpacesContext();
	const [teamOpen, setTeamOpen] = useState(false);
	const [spaceOpen, setSpaceOpen] = useState(false);
	// Opened with no target space, so the dialog shows its picker (defaulted to
	// the Uploads system space) rather than a dead end — there is no row here to
	// infer a Space from, unlike the sidebar's per-row "+".
	const [uploadOpen, setUploadOpen] = useState(false);
	const contributed = useContributedCreateActions();

	const handleCreateTeam = async (draft: TeamDraft) => {
		await createTeam(draft);
	};

	const builtIns: CreateMenuAction[] = [
		{
			id: "chat",
			label: "New chat",
			onSelect: () => openTab("/chat", { forceNew: true }),
		},
		{
			id: "agent",
			label: "New agent",
			onSelect: () => openCreateAgent(),
		},
		{
			id: "team",
			label: "New group",
			onSelect: () => setTeamOpen(true),
		},
		// No "New workflow" / "Build with AI" here: "New workflow" is the Workflows
		// app's own `contributes.create_actions` row, so it comes and goes with the
		// app.
		{
			id: "space",
			label: "New space",
			onSelect: () => setSpaceOpen(true),
		},
		{
			id: "space-upload",
			label: "Upload files",
			onSelect: () => setUploadOpen(true),
		},
	];

	return (
		<CreateMenuItemsContext value={[...builtIns, ...contributed]}>
			{children}
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
			<AddToSpaceDialog
				onClose={() => setUploadOpen(false)}
				open={uploadOpen}
				spaceId={null}
			/>
		</CreateMenuItemsContext>
	);
}

/** The account menu's "New" submenu: one plain row per create action. */
export function CreateSubmenu() {
	const items = use(CreateMenuItemsContext);
	if (items.length === 0) {
		return null;
	}
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger aria-label="Create new">
				<HugeiconsIcon className="size-4" icon={Add01Icon} />
				New
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="min-w-48">
				{items.map((item) => (
					<DropdownMenuItem key={item.id} onClick={() => item.onSelect()}>
						{item.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
