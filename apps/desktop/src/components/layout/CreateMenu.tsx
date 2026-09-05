// apps/desktop/src/components/layout/CreateMenu.tsx
//
// The sidebar-footer "+" create menu. The trigger IS the panel: a 28px circle
// that morphs open into the menu box (`.t-morph` / `.t-morph-plus` /
// `.t-morph-menu` in globals.css) rather than spawning a popover beside itself.
// Team and space need their shared create dialogs, so this component mounts them
// and toggles them from the matching row.
//
// Rows are styled after the landing-page header dropdown (packages/blocks/src/
// web/header.tsx): big semibold type, no icons, no descriptions. In a menu this
// dense an icon column and a second line of copy are what make it read as a
// settings list rather than a create affordance.
//
// The list is NOT hardcoded. The built-ins below are kernel-owned; everything
// else comes from enabled apps through `useContributedCreateActions` — see that
// module for the contribution seam and its one gap.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { AddToSpaceDialog } from "@/src/components/spaces/AddToSpaceDialog.tsx";
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
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";
import {
	type CreateMenuAction,
	useContributedCreateActions,
} from "./contributed-create-actions.ts";

// The open box has to be declared, not measured: `.t-morph` animates width and
// height, and a ResizeObserver feeding those back never settles (the hazard the
// old FloatingDisclosure port documented). Width is a literal because `text-xl`
// rows are width-stable; height is computed, because the row count is whatever
// the built-ins plus the enabled apps add up to.
const MORPH_OPEN_W = 232;
/** `text-xl` line box (28px) + `py-1` top and bottom. The panel is
 *  `justify-start`, not centred, on purpose: if this ever drifts from the real
 *  row height the box is visibly the wrong size instead of quietly absorbing the
 *  error into redistributed space that only clips once the list gets long. */
const ROW_H = 36;
/** The panel's `p-2`, both edges. */
const PANEL_PAD = 8;

export function CreateMenu() {
	// CreateMenu is always mounted in the sidebar footer, so calling the cap hook
	// here keeps the non-React planCapBridge singleton in sync with the resolved
	// entitlement — that is what lets the zustand `useNodeStore` enforce its remote-
	// node cap and open the same upgrade modal even when no other cap hook is up.
	useEntityCap();
	const { openTab } = useTabsContext();
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
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const contributed = useContributedCreateActions();

	// Close on outside pointerdown or Escape — the morph has no backdrop, and
	// there is no Base UI popover here that would own this for us.
	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (e: PointerEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setOpen(false);
			}
		};
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

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
		// No "New workflow" / "Build with AI" here any more. Both were hardcoded
		// rows for ONE app: they showed even with Workflows uninstalled, and led
		// straight to an error page. "New workflow" is now the Workflows app's own
		// `contributes.create_actions` row, so it comes and goes with the app;
		// "Build with AI" is deleted outright — a create menu is a list of things to
		// make, and "describe it and I'll build it" is the app's own surface, not a
		// seventh kind of thing.
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

	const items = [...builtIns, ...contributed];
	const morphVars = {
		"--morph-open-w": `${MORPH_OPEN_W}px`,
		"--morph-open-h": `${items.length * ROW_H + PANEL_PAD * 2}px`,
	} as CSSProperties;

	return (
		<>
			{/* A 28px slot the footer lays out, with the 40px morph anchored to its
			    bottom-right corner and overflowing it symmetrically. Growth therefore
			    runs up and to the left, and opening never reflows the sibling
			    inbox/downloads/settings buttons. */}
			<div className="relative size-7 shrink-0" ref={rootRef}>
				<div className="absolute -right-1.5 -bottom-1.5 z-50">
					{/* The lift rides the container, not the panel: `.t-morph` clips its
					    children, so a shadow on the panel inside would never be painted. */}
					<div
						className="t-morph data-[open=true]:shadow-lg"
						data-open={open}
						style={morphVars}
					>
						{/* `.t-morph-plus` fills the 40px closed box (that is what carries the
						    fade + rotate on open), so the BUTTON is the 28px child centred
						    inside it. Hanging the click on the 40px box instead would push the
						    hit area 6px past the slot, over the 2px gap and onto the inbox
						    trigger next door. */}
						<div className="t-morph-plus">
							<button
								aria-controls={panelId}
								aria-expanded={open}
								aria-haspopup="true"
								aria-label="Create new"
								className="flex size-7 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground motion-reduce:transition-none"
								onClick={() => setOpen((prev) => !prev)}
								type="button"
							>
								<HugeiconsIcon icon={Add01Icon} size={16} />
							</button>
						</div>
						{/* Pinned to the container's bottom-right at its full open size, so
						    the rows sit still while the box grows past them instead of
						    travelling with its top-left corner. */}
						<div
							className="t-morph-menu absolute right-0 bottom-0 flex flex-col justify-start rounded-[20px] border border-border bg-popover p-2 text-popover-foreground"
							id={panelId}
							inert={!open}
							style={{
								width: "var(--morph-open-w)",
								height: "var(--morph-open-h)",
							}}
						>
							{items.map((item) => (
								<button
									className="rounded-xl px-3 py-1 text-left font-medium text-foreground text-xl tracking-tight transition-colors hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none"
									key={item.id}
									onClick={() => {
										item.onSelect();
										setOpen(false);
									}}
									type="button"
								>
									<span className="block truncate">{item.label}</span>
								</button>
							))}
						</div>
					</div>
				</div>
			</div>
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
		</>
	);
}
