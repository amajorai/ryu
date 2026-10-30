import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUpRight01Icon,
	Delete01Icon,
	DeliverySecure01Icon,
	ImageAdd01Icon,
	PencilEdit01Icon,
	UserMultiple02Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { type DragEvent as ReactDragEvent, useState } from "react";
import { EntityIconDialog } from "@/src/components/layout/EntityIconDialog.tsx";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { ResourceVisibilityIndicator } from "@/src/components/layout/ResourceVisibilityIndicator.tsx";
import { RenameSpaceDialog } from "@/src/components/spaces/RenameSpaceDialog.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import type { Space, SpaceDocument } from "@/src/lib/api/spaces.ts";
import {
	RESOURCE_VISIBILITY_DND_MIME,
	resourceVisibilityDndMime,
	resourceVisibilityGroup,
	serializeVisibilityDragPayload,
	type VisibilityChangeRequest,
} from "@/src/lib/resource-visibility.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { SubSectionActionButton } from "./sidebar-section.tsx";
import { SidebarSpaceDocs } from "./sidebar-space-picker.tsx";
import { EntityRowGlyph, useContributedRowsFor } from "./tab-entity-menu.tsx";

export function SpaceSidebarRow({
	space,
	appIcon,
	listDocuments,
	onAdd,
	onOpen,
	onOpenDocInNewWindow,
	onOpenInNewTab,
	onOpenDoc,
	onOpenInNewWindow,
	onRequestDelete,
	onRename,
	onRequestVisibilityChange,
	canDelete,
	canMakePrivate,
	setDocumentIcon,
	setSpaceIcon,
}: {
	/** Icon id registered by the space's owning app (Iconify/icons0/Hugeicons id),
	 *  resolved through the shared <Icon> primitive. Undefined for a plain
	 *  user-created space, which keeps the default glyph. */
	appIcon?: string;
	listDocuments: (spaceId: string) => Promise<SpaceDocument[]>;
	/** Open the add-to-space dialog for THIS space (upload / new page / new
	 *  database) — the hover "+" every other section's rows made people expect. */
	onAdd: () => void;
	onOpen: () => void;
	onOpenDoc: (doc: SpaceDocument, forceNew?: boolean) => void;
	onOpenDocInNewWindow: (doc: SpaceDocument) => void;
	onOpenInNewTab: () => void;
	onOpenInNewWindow: () => void;
	onRequestDelete: () => void;
	onRename: (name: string) => Promise<void>;
	onRequestVisibilityChange: (request: VisibilityChangeRequest) => void;
	canDelete: boolean;
	canMakePrivate: boolean;
	setDocumentIcon: (
		spaceId: string,
		documentId: string,
		icon: GlyphValue
	) => Promise<void>;
	setSpaceIcon: (id: string, icon: GlyphValue) => Promise<void>;
	space: Space;
}) {
	const tl = useLiteralMessages();
	const updateTabsIconWhere = useTabSelector(
		(state) => state.updateTabsIconWhere
	);
	// Contributed `space`-anchored rows — see the note in AgentsSection.
	const spaceContributedRows = useContributedRowsFor("space", "space_id");
	const [expanded, setExpanded] = useState(false);
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);
	const toggle = () => setExpanded((v) => !v);
	const visibilityGroup = resourceVisibilityGroup(
		space.visibility,
		space.system
	);
	const handleVisibilityDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
		if (space.system) {
			return;
		}
		event.dataTransfer.effectAllowed = "move";
		const payload = serializeVisibilityDragPayload({
			from: visibilityGroup,
			id: space.id,
			name: space.name,
			resourceType: "space",
		});
		event.dataTransfer.setData(RESOURCE_VISIBILITY_DND_MIME, payload);
		event.dataTransfer.setData(resourceVisibilityDndMime("space"), "1");
		event.dataTransfer.setData("text/plain", payload);
	};
	const fallbackIcon = appIcon ? (
		<Icon
			className="absolute inset-0 m-auto"
			icon={appIcon}
			motion="opacity"
			size={16}
			visibility={expanded ? "concealed" : "row-hover"}
		/>
	) : (
		<HugeiconsIcon
			className={`absolute inset-0 m-auto size-4 transition-opacity ${
				expanded
					? "opacity-0"
					: "opacity-100 group-hover/row:opacity-0 group-focus-visible/row:opacity-0 group-has-[button:focus-visible]/row:opacity-0"
			}`}
			icon={DeliverySecure01Icon}
		/>
	);
	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger>
					{/* sidebar row combines nested controls with drag/middle-click */}
					<div
						className="group/row group/subsection flex h-8 cursor-grab items-center gap-2 rounded-lg px-2 transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0 active:cursor-grabbing"
						draggable={!space.system}
						onAuxClick={(e) => {
							if (e.button === 1) {
								e.preventDefault();
								onOpenInNewTab();
							}
						}}
						onClick={toggle}
						onDragStart={handleVisibilityDragStart}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								toggle();
							}
						}}
						role="button"
						tabIndex={0}
					>
						{/* The space glyph doubles as the disclosure control: it shows the
						    space icon at rest and morphs to a chevron on hover / once
						    expanded, so the row reads as an expandable folder. */}
						<span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
							{space.icon ? (
								<span
									className={`absolute inset-0 m-auto flex items-center justify-center transition-opacity ${
										expanded
											? "opacity-0"
											: "opacity-100 group-hover/row:opacity-0 group-focus-visible/row:opacity-0 group-has-[button:focus-visible]/row:opacity-0"
									}`}
								>
									<GlyphDisplay fallback={null} size={16} value={space.icon} />
								</span>
							) : (
								fallbackIcon
							)}
							<HugeiconsIcon
								className={`size-3 transition-[opacity,rotate] motion-reduce:transition-opacity ${
									expanded
										? "opacity-100"
										: "-rotate-90 opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 group-has-[button:focus-visible]/row:opacity-100"
								}`}
								icon={ArrowDown01Icon}
							/>
						</span>
						<OverflowTooltip
							className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm"
							fade
							text={space.name}
						/>
						<ResourceVisibilityIndicator
							system={space.system}
							visibility={space.visibility}
						/>
						{/* Count and "+" share one slot, swapped on hover the same way the
						    glyph above swaps to its chevron — an h-8 row has no width for
						    both, and overlaying keeps the row from reflowing under the
						    pointer. The button stays mounted (opacity-driven, not
						    `hidden`) so it is still reachable by keyboard. */}
						<span className="relative flex min-w-5 shrink-0 items-center justify-center">
							<span className="text-muted-foreground/70 text-xs tabular-nums transition-opacity group-hover/row:opacity-0">
								{space.documentCount}
							</span>
							<span className="absolute inset-0 flex items-center justify-center">
								<SubSectionActionButton
									icon={Add01Icon}
									onClick={onAdd}
									title={tl("Add to {name}", { name: space.name })}
								/>
							</span>
						</span>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onClick={onOpen}>
						<HugeiconsIcon className="size-4" icon={DeliverySecure01Icon} />
						Open space page
					</ContextMenuItem>
					<ContextMenuItem onClick={onOpenInNewTab}>
						<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
						Open in new tab
					</ContextMenuItem>
					<OpenInNewWindowContextMenuItem onClick={onOpenInNewWindow} />
					<ContextMenuItem onClick={() => setIconDialogOpen(true)}>
						<HugeiconsIcon className="size-4" icon={ImageAdd01Icon} />
						Change icon…
					</ContextMenuItem>
					{space.system ? null : (
						<ContextMenuItem onClick={() => setRenameOpen(true)}>
							<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
							Rename space
						</ContextMenuItem>
					)}
					{space.system ? null : (
						<ContextMenuItem
							disabled={visibilityGroup === "team" && !canMakePrivate}
							onClick={() =>
								onRequestVisibilityChange({
									from: visibilityGroup,
									id: space.id,
									name: space.name,
									resourceType: "space",
									to: visibilityGroup === "team" ? "private" : "team",
								})
							}
						>
							<HugeiconsIcon
								className="size-4"
								icon={
									resourceVisibilityGroup(space.visibility) === "team"
										? ViewOffSlashIcon
										: UserMultiple02Icon
								}
							/>
							{visibilityGroup === "team"
								? canMakePrivate
									? "Make private"
									: "Make private (admins only)"
								: "Share with team"}
						</ContextMenuItem>
					)}
					<ContextMenuSeparator />
					{/* A Ryu-owned system Space (Artifacts, Meetings, Uploads…) is a node
					    singleton Core refuses to delete — `SpaceStore::delete_space`
					    bails on `system = 1`, so offering the action here could only ever
					    produce the "Couldn't delete this space" toast. Disabled rather
					    than hidden: a menu that silently loses a row reads as a bug, and
					    the tooltip is where the reason belongs. The wrapper span carries
					    the tooltip because a disabled item is `pointer-events-none` and
					    would never see the hover itself. */}
					{space.system || !canDelete ? (
						<Tooltip>
							<TooltipTrigger render={<span className="block" />}>
								<ContextMenuItem disabled variant="destructive">
									<HugeiconsIcon className="size-4" icon={Delete01Icon} />
									Delete space
								</ContextMenuItem>
							</TooltipTrigger>
							<TooltipContent className="max-w-56">
								{space.system
									? "System spaces can't be deleted — Ryu creates and maintains this one."
									: "Only organization members with Space delete permission can delete Spaces."}
							</TooltipContent>
						</Tooltip>
					) : (
						<ContextMenuItem onClick={onRequestDelete} variant="destructive">
							<HugeiconsIcon className="size-4" icon={Delete01Icon} />
							Delete space
						</ContextMenuItem>
					)}
					{spaceContributedRows(space.id).map((row) => (
						<ContextMenuItem key={row.id} onClick={row.onSelect}>
							<span className="inline-flex">
								<EntityRowGlyph row={row} />
							</span>
							{row.label}
						</ContextMenuItem>
					))}
				</ContextMenuContent>
			</ContextMenu>
			{expanded && (
				<SidebarSpaceDocs
					listDocuments={listDocuments}
					onOpenDoc={onOpenDoc}
					onOpenInNewWindow={onOpenDocInNewWindow}
					setDocumentIcon={setDocumentIcon}
					spaceId={space.id}
				/>
			)}
			<EntityIconDialog
				description={space.name}
				onChange={(next) => {
					updateTabsIconWhere((t) => t.path === `/spaces/${space.id}`, next);
					void setSpaceIcon(space.id, next).catch(() => {
						toast.error("Couldn't update space icon");
					});
				}}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				title="Space icon"
				value={space.icon}
			/>
			<RenameSpaceDialog
				onClose={() => setRenameOpen(false)}
				onRename={onRename}
				open={renameOpen}
				space={space}
			/>
		</SidebarMenuItem>
	);
}
