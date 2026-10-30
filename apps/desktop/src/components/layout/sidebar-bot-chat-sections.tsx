import {
	Add01Icon,
	BubbleChatIcon,
	Delete01Icon,
	Folder01Icon,
	FolderOpenIcon,
	MoreHorizontalIcon,
	PencilEdit01Icon,
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
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { type ReactNode, useMemo, useState } from "react";
import { useOptionalChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import {
	BOT_CHAT_SECTION_COLLAPSED_KEY,
	BOT_CHAT_SECTION_ORDER_KEY,
} from "@/src/hooks/useBotChatSections.ts";
import {
	type BotChatSection,
	type BotChatSectionState,
	BUILTIN_SECTION_IDS,
	builtinSectionLabel,
	canNestBotChatSection,
	conversationsForSection,
	PROJECTS_SECTION_ID,
	parentSectionOf,
	UNORGANIZED_SECTION_ID,
} from "@/src/lib/bot-chat-sections.ts";
import type { Conversation } from "@/types/chat.ts";
import { CreateProjectDialog } from "./CreateProjectDialog.tsx";
import {
	clearSidebarChatSelection,
	draggedSidebarChatIds,
	useSidebarChatSelection,
} from "./sidebar-chat-selection.tsx";
import { ChatRowList } from "./sidebar-conversation-list.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import {
	type SubSectionNesting,
	useNestedSections,
} from "./sidebar-nested-sections.ts";
import { SubSectionActionButton } from "./sidebar-section.tsx";
import { SubSection } from "./sidebar-subsection.tsx";

/** A right-click "Delete all chats" affordance for a section or sub-section
 *  header. Wraps the header in a context menu whose destructive item opens a
 *  confirmation dialog; on confirm every conversation in `conversationIds` is
 *  deleted (one optimistic-local removal + one best-effort DELETE apiece — Core
 *  has no bulk endpoint). The menu item is disabled when the group is empty so
 *  the header still gets a menu (rather than falling through to the sidebar-wide
 *  one) but offers nothing destructive to do. */
export function DeleteAllChatsMenu({
	children,
	conversationIds,
	groupLabel,
	onDelete,
	scope,
}: {
	children: ReactNode;
	conversationIds: string[];
	/** Human name of the group, e.g. "Today" or "Chats" — used in the copy. */
	groupLabel: string;
	onDelete: (id: string) => void;
	/** "group" → "Delete all chats in {label}"; "all" → "Delete all chats". */
	scope: "all" | "group";
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const tl = useLiteralMessages();
	const count = conversationIds.length;
	const countLabel = String(count);
	const itemLabel =
		scope === "all"
			? tl("Delete all chats")
			: tl("Delete all chats in {groupLabel}", { groupLabel });
	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger>{children}</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem
						disabled={count === 0}
						onClick={() => setConfirmOpen(true)}
						variant="destructive"
					>
						<HugeiconsIcon className="size-4" icon={Delete01Icon} />
						{itemLabel}
						{count > 0 && (
							<span className="ml-auto pl-2 text-muted-foreground/70">
								{count}
							</span>
						)}
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			<AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{scope === "all"
								? tl(
										"Delete all {count, plural, one {{countLabel} chat} other {{countLabel} chats}}?",
										{ count, countLabel }
									)
								: tl(
										"Delete all {count, plural, one {{countLabel} chat} other {{countLabel} chats}} in {groupLabel}?",
										{
											count,
											countLabel,
											groupLabel,
										}
									)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{scope === "group"
								? tl(
										'This permanently deletes {count, plural, one {{countLabel} chat} other {{countLabel} chats}} in "{groupLabel}". This cannot be undone.',
										{ count, countLabel, groupLabel }
									)
								: tl(
										"This permanently deletes {count, plural, one {{countLabel} chat} other {{countLabel} chats}}. This cannot be undone.",
										{ count, countLabel }
									)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								for (const id of conversationIds) {
									onDelete(id);
								}
								setConfirmOpen(false);
							}}
							variant="destructive"
						>
							{tl(
								"Delete {count, plural, one {{countLabel} chat} other {{countLabel} chats}}",
								{ count, countLabel }
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

interface BotChatSectionMoveTarget {
	id: string | null;
	label: string;
}

/** Where a custom section can move: top level when nested, plus every other
 *  custom section it can nest under without forming a cycle. */
export function botChatSectionMoveTargets(
	state: BotChatSectionState,
	sectionId: string
): BotChatSectionMoveTarget[] {
	const targets: BotChatSectionMoveTarget[] = [];
	const currentParent = parentSectionOf(state, sectionId);
	if (currentParent !== null) {
		targets.push({ id: null, label: "Top level" });
	}
	for (const section of state.sections) {
		if (
			section.id !== currentParent &&
			canNestBotChatSection(state, sectionId, section.id)
		) {
			targets.push({ id: section.id, label: section.name });
		}
	}
	return targets;
}

export function BotChatSectionMenu({
	label,
	moveTargets,
	onDelete,
	onMove,
	onRename,
}: {
	label: string;
	/** Where this section can move: other sections, or top level (`id: null`). */
	moveTargets: BotChatSectionMoveTarget[];
	onDelete: () => void;
	onMove: (parentId: string | null) => void;
	onRename: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={tl("{label} options", { label })}
				className="flex size-5 shrink-0 items-center justify-center"
				motion="opacity"
				onClick={(event) => event.stopPropagation()}
				reveal="subsection"
				variant="muted"
			>
				<HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={onRename}>
					<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
					Rename section
				</DropdownMenuItem>
				{moveTargets.length > 0 && (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<HugeiconsIcon className="size-4" icon={FolderOpenIcon} />
							Move section to
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							{moveTargets.map((target) => (
								<DropdownMenuItem
									key={target.id ?? "top-level"}
									onClick={() => onMove(target.id)}
								>
									{target.label}
								</DropdownMenuItem>
							))}
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				)}
				<DropdownMenuItem onClick={onDelete} variant="destructive">
					<HugeiconsIcon className="size-4" icon={Delete01Icon} />
					Delete section
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function BotModeChatSectionsBody({
	handlers,
	loose,
	onAssignMany,
	onDelete,
	onNest,
	onOpenRename,
	sectionState,
	sections,
	sessionSource,
}: {
	handlers: ChatRowHandlers;
	loose: Conversation[];
	/** File chats under a section in one update (a drop can carry several). */
	onAssignMany: (conversationIds: readonly string[], sectionId: string) => void;
	onDelete: (sectionId: string) => void;
	/** Move a custom section inside another one, or to top level (`null`). */
	onNest: (sectionId: string, parentId: string | null) => void;
	onOpenRename: (section: BotChatSection) => void;
	sectionState: BotChatSectionState;
	sections: BotChatSection[];
	/** Console: every conversation, so sessions can expand beneath their row. */
	sessionSource?: Conversation[];
}) {
	const sessionsByParent = useMemo(() => {
		if (!sessionSource) {
			return null;
		}
		const map = new Map<string, Conversation[]>();
		for (const conversation of sessionSource) {
			const parent = conversation.hierarchy?.spawnedByConversationId;
			if (!parent) {
				continue;
			}
			const list = map.get(parent);
			if (list) {
				list.push(conversation);
			} else {
				map.set(parent, [conversation]);
			}
		}
		return map;
	}, [sessionSource]);
	const sessionsFor = sessionsByParent
		? (id: string) => sessionsByParent.get(id) ?? []
		: undefined;
	const [createProjectOpen, setCreateProjectOpen] = useState(false);
	const openTab = useTabSelector((state) => state.openTab);
	const refreshHistory = useOptionalChatHistoryContext()?.refresh;
	// Projects and Chats are the built-in defaults; the user's own sections
	// follow. All are reorderable, and the order syncs with the account.
	const sectionIds = useMemo(
		() => [...BUILTIN_SECTION_IDS, ...sections.map((section) => section.id)],
		[sections]
	);
	// Custom sections nest like Zen sidebar folders: drop a header on the
	// middle of another custom section's header to move it inside, or on an
	// edge to place it beside that section at the same level.
	const nesting = useMemo<SubSectionNesting>(
		() => ({
			canNestInto: (dragKey, targetKey) =>
				canNestBotChatSection(sectionState, dragKey, targetKey),
			canPlaceBeside: (dragKey, targetKey) => {
				const parentId = parentSectionOf(sectionState, targetKey);
				return (
					parentSectionOf(sectionState, dragKey) === parentId ||
					canNestBotChatSection(sectionState, dragKey, parentId)
				);
			},
			onNestInto: (dragKey, targetKey) => onNest(dragKey, targetKey),
			onPlaceBeside: (dragKey, targetKey) => {
				const parentId = parentSectionOf(sectionState, targetKey);
				if (parentSectionOf(sectionState, dragKey) !== parentId) {
					onNest(dragKey, parentId);
				}
			},
		}),
		[onNest, sectionState]
	);
	const nested = useNestedSections(
		BOT_CHAT_SECTION_ORDER_KEY,
		BOT_CHAT_SECTION_COLLAPSED_KEY,
		sectionIds,
		false,
		nesting
	);
	const chatDragging = useSidebarChatSelection((state) => state.dragging);
	const anyDragging = chatDragging || nested.dnd.draggingKey !== null;
	const conversationIds = useMemo(
		() => new Set(loose.map((conversation) => conversation.id)),
		[loose]
	);
	const sectionsById = useMemo(
		() => new Map(sections.map((section) => [section.id, section])),
		[sections]
	);

	// One flat drag order serves every level: a parent draws its children in
	// the relative order they hold in `orderedKeys`.
	const childKeysOf = (parentId: string | null) =>
		nested.orderedKeys.filter(
			(key) => parentSectionOf(sectionState, key) === parentId
		);
	const renderSection = (sectionId: string): ReactNode => {
		const customSection = sectionsById.get(sectionId);
		const isUnorganized = sectionId === UNORGANIZED_SECTION_ID;
		const isProjects = sectionId === PROJECTS_SECTION_ID;
		const label =
			customSection?.name ?? builtinSectionLabel(sectionId) ?? "Section";
		const conversations = conversationsForSection(
			loose,
			sectionState,
			sectionId
		);
		const childKeys = customSection ? childKeysOf(sectionId) : [];

		return (
			<SubSection
				action={
					customSection ? (
						<BotChatSectionMenu
							label={label}
							moveTargets={botChatSectionMoveTargets(
								sectionState,
								customSection.id
							)}
							onDelete={() => onDelete(customSection.id)}
							onMove={(parentId) => {
								onNest(customSection.id, parentId);
								// Open the new parent and its ancestors so the moved
								// section stays visible.
								const opened = new Set<string>();
								let ancestor = parentId;
								while (ancestor !== null && !opened.has(ancestor)) {
									opened.add(ancestor);
									nested.expand(ancestor);
									ancestor = parentSectionOf(sectionState, ancestor);
								}
							}}
							onRename={() => onOpenRename(customSection)}
						/>
					) : isProjects ? (
						<SubSectionActionButton
							icon={Add01Icon}
							onClick={() => setCreateProjectOpen(true)}
							title="New project"
						/>
					) : undefined
				}
				collapsed={nested.isCollapsed(sectionId)}
				count={conversations.length}
				dnd={nested.dnd}
				icon={
					isProjects
						? Folder01Icon
						: isUnorganized
							? BubbleChatIcon
							: FolderOpenIcon
				}
				key={sectionId}
				label={label}
				onToggleCollapsed={nested.toggle}
				sectionKey={sectionId}
				size="md"
				testId={`bot-chat-section-${sectionId}`}
				visibilityDrop={{
					accept: "chat",
					canDrop: (payload) => conversationIds.has(payload.id),
					onDrop: (payload) => {
						// A multi-selection drag assigns every selected chat, in one
						// update so each assignment does not overwrite the last.
						onAssignMany(
							draggedSidebarChatIds(payload.id).filter((id) =>
								conversationIds.has(id)
							),
							sectionId
						);
						clearSidebarChatSelection();
					},
				}}
			>
				{childKeys.length > 0 && (
					<div
						className="ml-3 space-y-0.5 border-border border-l pl-1"
						data-testid={`bot-chat-section-children-${sectionId}`}
					>
						{childKeys.map(renderSection)}
					</div>
				)}
				{conversations.length > 0 ? (
					<ChatRowList
						conversations={conversations}
						handlers={handlers}
						sessionsFor={sessionsFor}
					/>
				) : childKeys.length > 0 || isProjects || isUnorganized ? null : (
					// An empty group collapses to its label; the drop hint shows only
					// while something is being dragged.
					anyDragging && (
						<p className="flex h-8 items-center px-2 text-detail text-muted-foreground">
							Drop a project, chat, or section here
						</p>
					)
				)}
			</SubSection>
		);
	};

	return (
		<div className="space-y-0.5">
			{childKeysOf(null).map(renderSection)}
			<CreateProjectDialog
				onCreated={(project) => {
					refreshHistory?.();
					if (project.coordinatorConversationId) {
						openTab("/chat", {
							conversationId: project.coordinatorConversationId,
							title: project.name,
						});
					}
				}}
				onOpenChange={setCreateProjectOpen}
				open={createProjectOpen}
				target={handlers.target}
			/>
		</div>
	);
}

export type BotChatSectionDialogState =
	| { id: null; initialName: string; mode: "create" }
	| { id: string; initialName: string; mode: "rename" };
