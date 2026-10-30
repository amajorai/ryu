// Bulk right-click menu and bulk-delete confirmation for a multi-selection of
// sidebar chat rows; see sidebar-chat-selection.tsx.

import {
	Archive01Icon,
	ArchiveRestoreIcon,
	Cancel01Icon,
	Delete01Icon,
	Folder01Icon,
	FolderOpenIcon,
	LinkSquare02Icon,
	Mail01Icon,
	PinIcon,
	PinOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import {
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { useEffect, useState } from "react";
import { create } from "zustand";
import type { SidebarChatBulkActions } from "./sidebar-chat-selection.tsx";
import {
	clearSidebarChatSelection,
	useSidebarChatSelection,
} from "./sidebar-chat-selection-store.ts";

/** The right-click menu for a row that is part of a multi-selection. */
export function SidebarChatBulkContextMenuContent({
	actions,
	archivedIds,
	pinnedIds,
	unreadIds,
}: {
	actions: SidebarChatBulkActions;
	archivedIds: ReadonlySet<string>;
	pinnedIds: ReadonlySet<string>;
	unreadIds: ReadonlySet<string>;
}) {
	const tl = useLiteralMessages();
	const selectedIds = useSidebarChatSelection((state) => state.selectedIds);
	const ids = [...selectedIds];
	const countValues = { count: ids.length, countText: String(ids.length) };
	const allPinned = ids.every((id) => pinnedIds.has(id));
	const allArchived = ids.every((id) => archivedIds.has(id));
	const anyUnread = ids.some((id) => unreadIds.has(id));
	const run = (action: () => void) => {
		action();
		clearSidebarChatSelection();
	};

	return (
		<ContextMenuContent>
			<ContextMenuGroup>
				<ContextMenuLabel>
					{tl(
						"{count, plural, one {{countText} chat} other {{countText} chats}} selected",
						countValues
					)}
				</ContextMenuLabel>
			</ContextMenuGroup>
			<ContextMenuItem onClick={() => run(() => actions.openInNewTabs(ids))}>
				<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
				Open in new tabs
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				onClick={() => run(() => actions.setPinned(ids, !allPinned))}
			>
				<HugeiconsIcon
					className="size-4"
					icon={allPinned ? PinOffIcon : PinIcon}
				/>
				{allPinned
					? tl(
							"Unpin {count, plural, one {{countText} chat} other {{countText} chats}}",
							countValues
						)
					: tl(
							"Pin {count, plural, one {{countText} chat} other {{countText} chats}}",
							countValues
						)}
			</ContextMenuItem>
			<ContextMenuItem
				onClick={() => run(() => actions.setArchived(ids, !allArchived))}
			>
				<HugeiconsIcon
					className="size-4"
					icon={allArchived ? ArchiveRestoreIcon : Archive01Icon}
				/>
				{allArchived
					? tl(
							"Unarchive {count, plural, one {{countText} chat} other {{countText} chats}}",
							countValues
						)
					: tl(
							"Archive {count, plural, one {{countText} chat} other {{countText} chats}}",
							countValues
						)}
			</ContextMenuItem>
			<ContextMenuItem
				onClick={() => run(() => actions.setRead(ids, anyUnread))}
			>
				<HugeiconsIcon className="size-4" icon={Mail01Icon} />
				{anyUnread ? "Mark as read" : "Mark as unread"}
			</ContextMenuItem>
			<ContextMenuSub>
				<ContextMenuSubTrigger>
					<HugeiconsIcon className="size-4" icon={FolderOpenIcon} />
					Move to project
				</ContextMenuSubTrigger>
				<ContextMenuSubContent className="max-h-[60vh] overflow-y-auto">
					{actions.projects.length === 0 ? (
						<ContextMenuItem disabled>No projects yet</ContextMenuItem>
					) : (
						actions.projects.map((project) => (
							<ContextMenuItem
								key={project.path}
								onClick={() =>
									run(() => actions.moveToProject(ids, project.path))
								}
							>
								<HugeiconsIcon className="size-4" icon={Folder01Icon} />
								<span className="truncate">{project.label}</span>
							</ContextMenuItem>
						))
					)}
					<ContextMenuSeparator />
					<ContextMenuItem
						onClick={() => run(() => actions.moveToProject(ids, null))}
					>
						Remove from project
					</ContextMenuItem>
				</ContextMenuSubContent>
			</ContextMenuSub>
			<ContextMenuSeparator />
			<ContextMenuItem onClick={clearSidebarChatSelection}>
				<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
				Clear selection
			</ContextMenuItem>
			<ContextMenuItem
				onClick={() =>
					useSidebarChatSelection.setState({ pendingDeleteIds: ids })
				}
				variant="destructive"
			>
				<HugeiconsIcon className="size-4" icon={Delete01Icon} />
				{tl(
					"Delete {count, plural, one {{countText} chat} other {{countText} chats}}",
					countValues
				)}
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

/** Every mounted bulk-delete dialog, in mount order. Two sidebars can be mounted
 *  at once (the collapsed docked panel and the floating peek panel), and they
 *  share {@link useSidebarChatSelection}'s pending ids, so only the first one
 *  renders; otherwise one Delete would stack two confirmations. */
const useBulkDeleteDialogHosts = create<{ hosts: readonly symbol[] }>(() => ({
	hosts: [],
}));

function useIsBulkDeleteDialogHost(): boolean {
	const [token] = useState(() => Symbol("sidebar-chat-bulk-delete-dialog"));
	useEffect(() => {
		useBulkDeleteDialogHosts.setState((state) => ({
			hosts: [...state.hosts, token],
		}));
		return () => {
			useBulkDeleteDialogHosts.setState((state) => ({
				hosts: state.hosts.filter((host) => host !== token),
			}));
		};
	}, [token]);
	return useBulkDeleteDialogHosts((state) => state.hosts[0] === token);
}

/** Confirmation for the bulk Delete row. Mounted by each sidebar so it outlives
 *  the context menu that opened it; only one mounted copy renders at a time. */
export function SidebarChatBulkDeleteDialog({
	onDelete,
}: {
	onDelete: (ids: readonly string[]) => void;
}) {
	const tl = useLiteralMessages();
	const isHost = useIsBulkDeleteDialogHost();
	const pendingIds = useSidebarChatSelection((state) => state.pendingDeleteIds);
	if (!isHost) {
		return null;
	}
	const pendingCount = pendingIds?.length ?? 0;
	const countValues = {
		count: pendingCount,
		countText: String(pendingCount),
	};
	const close = () =>
		useSidebarChatSelection.setState({ pendingDeleteIds: null });
	return (
		<AlertDialog
			onOpenChange={(open) => {
				if (!open) {
					close();
				}
			}}
			open={pendingIds !== null}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{tl(
							"Delete {count, plural, one {{countText} chat} other {{countText} chats}}?",
							countValues
						)}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{tl(
							"This permanently deletes {count, plural, one {{countText} chat} other {{countText} chats}}. This cannot be undone.",
							countValues
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							if (pendingIds) {
								onDelete(pendingIds);
							}
							clearSidebarChatSelection();
							close();
						}}
						variant="destructive"
					>
						{tl(
							"Delete {count, plural, one {{countText} chat} other {{countText} chats}}",
							countValues
						)}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
