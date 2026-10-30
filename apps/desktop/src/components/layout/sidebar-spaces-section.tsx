import {
	UserMultiple02Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { SidebarMenu } from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useMemo, useState } from "react";
import { ResourceVisibilityConfirmationDialog } from "@/src/components/layout/ResourceVisibilityConfirmationDialog.tsx";
import { AddToSpaceDialog } from "@/src/components/spaces/AddToSpaceDialog.tsx";
import { CreateSpaceDialog } from "@/src/components/spaces/LazyCreateSpaceDialog.tsx";
import { DestructiveConfirmDialog } from "@/src/components/ui/DestructiveConfirmDialog.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useCanManagePermission } from "@/src/hooks/useGatewayConfigurable.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useSidebarGroupedNav } from "@/src/hooks/useSidebarGroupedNav.ts";
import { useVisibilityAdminAccess } from "@/src/hooks/useVisibilityAdminAccess.ts";
import type { Space, SpaceDocument } from "@/src/lib/api/spaces.ts";
import {
	type ResourceVisibilityGroup,
	resourceVisibilityForGroup,
	resourceVisibilityGroup,
	resourceVisibilityLabel,
	type VisibilityChangeRequest,
	type VisibilityDragPayload,
} from "@/src/lib/resource-visibility.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import { SectionLoadError } from "./sidebar-agents-section.tsx";
import { useNestedSections } from "./sidebar-nested-sections.ts";
import { SpaceScopeMenu } from "./sidebar-scope-menus.tsx";
import {
	ALL_SELECTION,
	SidebarScopePicker,
	SPACE_VISIBILITY_COLLAPSED_KEY,
	SPACE_VISIBILITY_ORDER_KEY,
	usePickerSelection,
} from "./sidebar-scope-picker.tsx";
import {
	SectionAddButton,
	type SectionProps,
	SidebarSection,
} from "./sidebar-section.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import {
	NAMED_SORT_ACCESSORS,
	sortItems,
	usePaged,
} from "./sidebar-sort-paging.ts";
import { SpacesPickerBody, spaceDocPath } from "./sidebar-space-picker.tsx";
import { SpaceSidebarRow } from "./sidebar-space-row.tsx";
import { SubSection } from "./sidebar-subsection.tsx";
import { useContributedRowsFor } from "./tab-entity-menu.tsx";

export function SpacesSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const tl = useLiteralMessages();
	const openTab = useTabSelector((state) => state.openTab);
	const {
		spaces,
		loading,
		error,
		reload,
		create,
		remove,
		rename,
		listDocuments,
		setSpaceIcon,
		setSpaceVisibility,
		setDocumentIcon,
	} = useSpacesContext();
	const { canMakePrivate } = useVisibilityAdminAccess();
	const canDeleteSpaces = useCanManagePermission("space.delete");
	const [pendingVisibility, setPendingVisibility] =
		useState<VisibilityChangeRequest | null>(null);
	const [changingVisibility, setChangingVisibility] = useState(false);
	const requestVisibilityChange = useCallback(
		(request: VisibilityChangeRequest) => {
			if (request.to === "private" && !canMakePrivate) {
				toast.error(
					"Only organization admins can make shared resources private"
				);
				return;
			}
			setPendingVisibility(request);
		},
		[canMakePrivate]
	);
	const confirmVisibilityChange = useCallback(async () => {
		if (!pendingVisibility) {
			return;
		}
		if (pendingVisibility.to === "private" && !canMakePrivate) {
			toast.error("Only organization admins can make shared resources private");
			return;
		}
		setChangingVisibility(true);
		try {
			await setSpaceVisibility(
				pendingVisibility.id,
				resourceVisibilityForGroup(pendingVisibility.to)
			);
			setPendingVisibility(null);
		} catch {
			toast.error("Couldn't change this Space's visibility", {
				description: "The Space stayed in its current group.",
			});
		} finally {
			setChangingVisibility(false);
		}
	}, [canMakePrivate, pendingVisibility, setSpaceVisibility]);
	const visibilityDropFor = (group: ResourceVisibilityGroup) => ({
		accept: "space" as const,
		canDrop: (_payload: VisibilityDragPayload) =>
			group !== "private" || canMakePrivate,
		canDropOnDragOver: () => group !== "private" || canMakePrivate,
		onDrop: (payload: VisibilityDragPayload) =>
			requestVisibilityChange({
				...payload,
				to: group,
			}),
	});
	const [createOpen, setCreateOpen] = useState(false);
	// The row "+" target. Held at section level, and the dialog below stays mounted
	// across `null`, so an upload started from one row keeps running (and keeps
	// reporting) if the user closes it — its queue lives in that component.
	const [addTargetId, setAddTargetId] = useState<string | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	// Deleting a space is permanent, so the right-click Delete action opens a
	// confirmation dialog (rather than removing it outright); the pending target
	// is held here so the single shared dialog knows which space to delete.
	const [pendingDelete, setPendingDelete] = useState<{
		id: string;
		name: string;
	} | null>(null);
	const [deleting, setDeleting] = useState(false);
	// The "Meetings" system space is shown here as its own space (per request) — no
	// longer name-filtered out of the list.
	const visibleSpaces = spaces;
	const [groupedNav] = useSidebarGroupedNav();
	// The picker model has no space ROW to hang app-contributed actions off, so the
	// section resolves them itself and the scope menu renders them for the selection
	// — same rows a space row's context menu shows, same anchor.
	const spaceContributedRows = useContributedRowsFor("space", "space_id");
	const spacesByVisibility = useMemo(
		() =>
			visibleSpaces.reduce<Record<ResourceVisibilityGroup, Space[]>>(
				(groups, space) => {
					groups[resourceVisibilityGroup(space.visibility, space.system)].push(
						space
					);
					return groups;
				},
				{ private: [], team: [] }
			),
		[visibleSpaces]
	);
	const visibilityGroupKeys = useMemo(
		(): ResourceVisibilityGroup[] => ["private", "team"],
		[]
	);
	const visibilityGroups = useNestedSections(
		SPACE_VISIBILITY_ORDER_KEY,
		SPACE_VISIBILITY_COLLAPSED_KEY,
		visibilityGroupKeys,
		false
	);
	const privateOptions = useMemo(
		() =>
			spacesByVisibility.private.map((s) => ({ label: s.name, value: s.id })),
		[spacesByVisibility.private]
	);
	const teamOptions = useMemo(
		() => spacesByVisibility.team.map((s) => ({ label: s.name, value: s.id })),
		[spacesByVisibility.team]
	);
	const [privateSelection, setPrivateSelection] = usePickerSelection(
		"ryu:sidebar-private-space-selection",
		privateOptions
	);
	const [teamSelection, setTeamSelection] = usePickerSelection(
		"ryu:sidebar-team-space-selection",
		teamOptions
	);
	const selectedPrivateSpace =
		privateSelection === ALL_SELECTION
			? null
			: (spacesByVisibility.private.find((s) => s.id === privateSelection) ??
				null);
	const selectedTeamSpace =
		teamSelection === ALL_SELECTION
			? null
			: (spacesByVisibility.team.find((s) => s.id === teamSelection) ?? null);
	// Map an app companion's label → the icon id it registered, so a system space
	// (Canvas/Whiteboard/Meetings/…) shows its owning app's icon, resolved through
	// the shared <Icon> primitive. Data-driven off /api/plugins/contributions — no
	// hardcoded name→icon map in the shell. A space with no matching app keeps the
	// default glyph.
	const { companions } = usePluginContributions();
	const appIconBySpaceName = useMemo(() => {
		const map = new Map<string, string>();
		for (const companion of companions) {
			const key = (companion.label || companion.name)?.toLowerCase();
			if (key && companion.icon) {
				map.set(key, companion.icon);
			}
		}
		return map;
	}, [companions]);
	const privatePaged = usePaged(
		sortItems(spacesByVisibility.private, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);
	const teamPaged = usePaged(
		sortItems(spacesByVisibility.team, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const visibilityIcon = (group: ResourceVisibilityGroup) =>
		group === "private" ? ViewOffSlashIcon : UserMultiple02Icon;
	const visibilityLabel = (group: ResourceVisibilityGroup) =>
		group === "private" ? resourceVisibilityLabel("private") : "Team";

	const renderSpacePickerGroup = (group: ResourceVisibilityGroup) => {
		const groupSpaces = spacesByVisibility[group];
		const isPrivate = group === "private";
		const selection = isPrivate ? privateSelection : teamSelection;
		const setSelection = isPrivate ? setPrivateSelection : setTeamSelection;
		const selectedSpace = isPrivate ? selectedPrivateSpace : selectedTeamSpace;
		const shownSpaces =
			selection === ALL_SELECTION
				? groupSpaces
				: groupSpaces.filter((space) => space.id === selection);

		return (
			<SubSection
				collapsed={visibilityGroups.isCollapsed(group)}
				count={groupSpaces.length}
				dnd={visibilityGroups.dnd}
				icon={visibilityIcon(group)}
				key={group}
				label={visibilityLabel(group)}
				onToggleCollapsed={visibilityGroups.toggle}
				sectionKey={group}
				size="md"
				visibilityDrop={visibilityDropFor(group)}
			>
				<SidebarScopePicker
					actions={
						selectedSpace ? (
							<SpaceScopeMenu
								canDelete={canDeleteSpaces}
								canMakePrivate={canMakePrivate}
								contributedRows={spaceContributedRows(selectedSpace.id)}
								onAdd={() => {
									setAddTargetId(selectedSpace.id);
									setAddOpen(true);
								}}
								onOpen={() => openSpace(selectedSpace)}
								onOpenInNewTab={() => openSpace(selectedSpace, true)}
								onOpenInNewWindow={() => openSpaceInNewWindow(selectedSpace)}
								onRename={(name) => rename(selectedSpace.id, name)}
								onRequestDelete={() =>
									setPendingDelete({
										id: selectedSpace.id,
										name: selectedSpace.name,
									})
								}
								onRequestVisibilityChange={requestVisibilityChange}
								setSpaceIcon={setSpaceIcon}
								space={selectedSpace}
							/>
						) : undefined
					}
					allLabel={isPrivate ? "All private spaces" : "All team spaces"}
					icon={visibilityIcon(group)}
					onValueChange={setSelection}
					options={isPrivate ? privateOptions : teamOptions}
					value={selection}
				/>
				<SpacesPickerBody
					listDocuments={listDocuments}
					onOpenDoc={(doc, forceNew) => openDoc(doc.spaceId, doc, forceNew)}
					onOpenInNewWindow={openDocInNewWindow}
					pageSize={pageSize}
					setDocumentIcon={setDocumentIcon}
					sort={sort}
					spaces={shownSpaces}
				/>
			</SubSection>
		);
	};

	const renderSpaceRowsGroup = (group: ResourceVisibilityGroup) => {
		const groupPaged = group === "private" ? privatePaged : teamPaged;
		return (
			<SubSection
				collapsed={visibilityGroups.isCollapsed(group)}
				count={spacesByVisibility[group].length}
				dnd={visibilityGroups.dnd}
				icon={visibilityIcon(group)}
				key={group}
				label={visibilityLabel(group)}
				onToggleCollapsed={visibilityGroups.toggle}
				sectionKey={group}
				size="md"
				visibilityDrop={visibilityDropFor(group)}
			>
				<SidebarMenu>{renderSpaceRows(groupPaged.visible)}</SidebarMenu>
				<SectionPagingControls
					overflow={{
						getSearchText: (space) => space.name ?? "",
						items: groupPaged.items,
						label: `${visibilityLabel(group).toLowerCase()} spaces`,
						renderList: (list) => (
							<SidebarMenu>{renderSpaceRows(list)}</SidebarMenu>
						),
					}}
					paged={groupPaged}
				/>
			</SubSection>
		);
	};

	// Open a specific space's page (`/spaces/:id`), pre-selecting it — the Spaces
	// page no longer renders its own space list, so selection is driven from here.
	const openSpace = (space: (typeof visibleSpaces)[number], forceNew = false) =>
		openTab(`/spaces/${space.id}`, {
			title: space.name,
			forceNew,
			icon: space.icon ?? null,
		});

	const openSpaceInNewWindow = (space: (typeof visibleSpaces)[number]) => {
		void openEntityInNewWindow({
			path: `/spaces/${space.id}`,
			title: space.name,
		});
	};

	// Open a document inside a space directly in its editor (databases use the
	// data-grid route, pages the markdown route) — mirrors SpacesPage.openDoc.
	const openDoc = (spaceId: string, doc: SpaceDocument, forceNew = false) => {
		openTab(spaceDocPath(spaceId, doc), {
			title: doc.title || "Untitled",
			icon: doc.icon ?? null,
			forceNew,
		});
	};

	const openDocInNewWindow = (doc: SpaceDocument) => {
		void openEntityInNewWindow({
			path: spaceDocPath(doc.spaceId, doc),
			title: doc.title || "Untitled",
		});
	};

	const confirmDelete = async (): Promise<boolean> => {
		if (!pendingDelete) {
			return false;
		}
		const { id, name } = pendingDelete;
		setDeleting(true);
		try {
			await remove(id);
			setPendingDelete(null);
			return true;
		} catch {
			toast.error("Couldn't delete this space", {
				description: tl(
					'"{name}" and its documents weren\'t deleted. Please try again.',
					{ name }
				),
			});
			return false;
		} finally {
			setDeleting(false);
		}
	};

	const emptyMessage = loading ? "Loading…" : "No spaces yet";

	const renderSpaceRows = (list: typeof visibleSpaces) =>
		list.map((space) => (
			<SpaceSidebarRow
				appIcon={appIconBySpaceName.get(space.name.toLowerCase())}
				canDelete={canDeleteSpaces}
				canMakePrivate={canMakePrivate}
				key={space.id}
				listDocuments={listDocuments}
				onAdd={() => {
					setAddTargetId(space.id);
					setAddOpen(true);
				}}
				onOpen={() => openSpace(space)}
				onOpenDoc={(doc, forceNew) => openDoc(space.id, doc, forceNew)}
				onOpenDocInNewWindow={openDocInNewWindow}
				onOpenInNewTab={() => openSpace(space, true)}
				onOpenInNewWindow={() => openSpaceInNewWindow(space)}
				onRename={(name) => rename(space.id, name)}
				onRequestDelete={() =>
					setPendingDelete({ id: space.id, name: space.name })
				}
				onRequestVisibilityChange={requestVisibilityChange}
				setDocumentIcon={setDocumentIcon}
				setSpaceIcon={setSpaceIcon}
				space={space}
			/>
		));
	const orderedVisibilityGroups = visibilityGroups.orderedKeys.filter(
		(key): key is ResourceVisibilityGroup => key === "private" || key === "team"
	);

	return (
		<>
			<SidebarSection
				action={
					<SectionAddButton
						onClick={() => setCreateOpen(true)}
						title="New space"
					/>
				}
				collapsed={collapsed}
				dnd={dnd}
				label="Spaces"
				menu={menu}
				onToggleCollapsed={onToggleCollapsed}
				pageSize={pageSize}
				sectionKey="spaces"
				sort={sort}
			>
				{error && visibleSpaces.length === 0 && (
					<SectionLoadError
						message="Couldn't load your spaces."
						onRetry={() => {
							reload().catch(() => undefined);
						}}
					/>
				)}
				{!error && visibleSpaces.length === 0 && (
					<p className="flex min-h-8 items-center px-2 text-detail text-muted-foreground">
						{emptyMessage}
					</p>
				)}
				{visibleSpaces.length > 0 &&
					(groupedNav
						? orderedVisibilityGroups.map(renderSpacePickerGroup)
						: orderedVisibilityGroups.map(renderSpaceRowsGroup))}
			</SidebarSection>
			<CreateSpaceDialog
				onClose={() => setCreateOpen(false)}
				onCreate={create}
				open={createOpen}
			/>
			<AddToSpaceDialog
				onClose={() => setAddOpen(false)}
				open={addOpen}
				spaceId={addTargetId}
			/>
			<ResourceVisibilityConfirmationDialog
				canMakePrivate={canMakePrivate}
				changing={changingVisibility}
				onConfirm={() => {
					confirmVisibilityChange().catch(() => undefined);
				}}
				onOpenChange={(open) => {
					if (!(open || changingVisibility)) {
						setPendingVisibility(null);
					}
				}}
				request={pendingVisibility}
			/>
			<DestructiveConfirmDialog
				busy={deleting}
				description={
					pendingDelete
						? `"${pendingDelete.name}" and all its documents will be permanently deleted. This can't be undone.`
						: ""
				}
				label={tl("Delete {name}", {
					name: pendingDelete?.name ?? tl("this Space"),
				})}
				onConfirm={confirmDelete}
				onOpenChange={(open) => {
					if (!(open || deleting)) {
						setPendingDelete(null);
					}
				}}
				open={pendingDelete !== null}
				title="Delete this Space?"
			/>
		</>
	);
}
