import {
	FolderAddIcon,
	Settings03Icon,
	Upload01Icon,
	UserMultiple02Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useContext, useMemo, useState } from "react";
import { useBotChatSections } from "@/src/hooks/useBotChatSections.ts";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import type {
	BotChatSection,
	BotChatSectionState,
} from "@/src/lib/bot-chat-sections.ts";
import {
	type ResourceVisibilityGroup,
	resourceVisibilityGroup,
} from "@/src/lib/resource-visibility.ts";
import type { Conversation } from "@/types/chat.ts";
import { BotChatSectionDialog } from "./BotChatSectionDialog.tsx";
import {
	type BotChatSectionDialogState,
	BotModeChatSectionsBody,
	DeleteAllChatsMenu,
} from "./sidebar-bot-chat-sections.tsx";
import {
	ChatGroupingContext,
	useFilteredChats,
} from "./sidebar-chat-grouping.tsx";
import { SidebarChatList } from "./sidebar-chat-list.tsx";
import { DEFAULT_CHAT_SECTION_VIEW } from "./sidebar-chat-view.ts";
import { ChatRowList } from "./sidebar-conversation-list.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import {
	CHAT_VISIBILITY_COLLAPSED_KEY,
	CHAT_VISIBILITY_ORDER_KEY,
	useNestedSections,
} from "./sidebar-nested-sections.ts";
import {
	SectionAddButton,
	type SectionProps,
	SidebarSection,
} from "./sidebar-section.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import {
	chatSearchText,
	sortItems,
	useConversationSortAccessors,
	usePaged,
} from "./sidebar-sort-paging.ts";
import { SubSection } from "./sidebar-subsection.tsx";

export function ChatsSection({
	botMode,
	chatView,
	collapsed,
	dnd,
	handlers,
	loose,
	managedProduct = false,
	menu,
	onImport,
	onImportSetup,
	onNew,
	onToggleCollapsed,
	pageSize,
	sectionLabel = "Chats",
	sessionSource,
	sort,
}: SectionProps & {
	botMode: boolean;
	handlers: ChatRowHandlers;
	loose: Conversation[];
	managedProduct?: boolean;
	/** Open the "import a past agent thread" dialog (Claude Code / Codex). */
	onImport?: () => void;
	/** Open the "import agent setup from a folder" dialog. */
	onImportSetup?: () => void;
	onNew: () => void;
	sectionLabel?: string;
	/** Console: every conversation, so sessions expand beneath main threads. */
	sessionSource?: Conversation[];
}) {
	const tl = useLiteralMessages();
	// The sidebar shares one custom-groups store across sections; harnesses that
	// mount Chats alone fall back to their own.
	const sharedGrouping = useContext(ChatGroupingContext);
	const localChatSections = useBotChatSections();
	const botChatSections = sharedGrouping?.groups ?? localChatSections;
	const view = chatView ?? DEFAULT_CHAT_SECTION_VIEW;
	const filteredLoose = useFilteredChats(loose, view);
	const conversationSort = useConversationSortAccessors();
	const sortedLoose = sortItems(filteredLoose, sort, conversationSort);
	const loosePaged = usePaged(sortedLoose, pageSize);
	const [sectionDialog, setSectionDialog] =
		useState<BotChatSectionDialogState | null>(null);
	const botChatSectionState = useMemo<BotChatSectionState>(
		() => ({
			assignments: botChatSections.assignments,
			sections: botChatSections.sections,
		}),
		[botChatSections.assignments, botChatSections.sections]
	);
	const [groupByDate] = useChatDateGrouping();
	const chatsByVisibility = useMemo(
		() =>
			filteredLoose.reduce<Record<ResourceVisibilityGroup, Conversation[]>>(
				(groups, conversation) => {
					groups[resourceVisibilityGroup(conversation.visibility)].push(
						conversation
					);
					return groups;
				},
				{ private: [], team: [] }
			),
		[filteredLoose]
	);
	const visibilityGroupKeys = useMemo(
		(): ResourceVisibilityGroup[] => ["private", "team"],
		[]
	);
	const visibilityGroups = useNestedSections(
		CHAT_VISIBILITY_ORDER_KEY,
		CHAT_VISIBILITY_COLLAPSED_KEY,
		visibilityGroupKeys,
		false
	);
	const privatePaged = usePaged(
		sortItems(chatsByVisibility.private, sort, conversationSort),
		pageSize
	);
	const teamPaged = usePaged(
		sortItems(chatsByVisibility.team, sort, conversationSort),
		pageSize
	);

	const renderVisibilityGroup = (group: ResourceVisibilityGroup) => {
		const groupChats = chatsByVisibility[group];
		const groupPaged = group === "private" ? privatePaged : teamPaged;
		const label = group === "private" ? "Private" : "Team";
		return (
			<SubSection
				collapsed={visibilityGroups.isCollapsed(group)}
				count={groupChats.length}
				dnd={visibilityGroups.dnd}
				icon={group === "private" ? ViewOffSlashIcon : UserMultiple02Icon}
				key={group}
				label={label}
				onToggleCollapsed={visibilityGroups.toggle}
				sectionKey={group}
				size="md"
				visibilityDrop={{
					accept: "chat",
					canDrop: () => group !== "private" || handlers.canMakePrivate,
					canDropOnDragOver: () =>
						group !== "private" || handlers.canMakePrivate,
					onDrop: (payload) =>
						handlers.onRequestConversationVisibility({
							...payload,
							to: group,
						}),
				}}
				wrapHeader={(header) => (
					<DeleteAllChatsMenu
						conversationIds={groupChats.map((conversation) => conversation.id)}
						groupLabel={
							group === "private" ? tl("Private chats") : tl("Team chats")
						}
						onDelete={handlers.onDeleteConversation}
						scope="group"
					>
						{header}
					</DeleteAllChatsMenu>
				)}
			>
				{groupByDate ? (
					<SidebarChatList
						conversations={groupChats}
						handlers={handlers}
						scope={`loose:${group}`}
					/>
				) : (
					<>
						<ChatRowList
							conversations={groupPaged.visible}
							handlers={handlers}
						/>
						<SectionPagingControls
							overflow={{
								getSearchText: chatSearchText,
								items: groupPaged.items,
								label: `${label.toLowerCase()} chats`,
								renderList: (list) => (
									<ChatRowList conversations={list} handlers={handlers} />
								),
							}}
							paged={groupPaged}
						/>
					</>
				)}
			</SubSection>
		);
	};
	const orderedVisibilityGroups = visibilityGroups.orderedKeys.filter(
		(key): key is ResourceVisibilityGroup => key === "private" || key === "team"
	);

	const openCreateSection = () =>
		setSectionDialog({ id: null, initialName: "", mode: "create" });
	const openRenameSection = (section: BotChatSection) =>
		setSectionDialog({
			id: section.id,
			initialName: section.name,
			mode: "rename",
		});
	const submitSectionDialog = (name: string) => {
		if (!sectionDialog) {
			return;
		}
		if (sectionDialog.mode === "create") {
			botChatSections.createSection(name);
		} else {
			botChatSections.renameSection(sectionDialog.id, name);
		}
	};

	return (
		<>
			<SidebarSection
				action={<SectionAddButton onClick={onNew} title="New chat" />}
				chatDrop={
					botMode ? undefined : handlers.bulk?.dropTarget({ kind: "chats" })
				}
				// Bot mode already organizes Chats into its own sections.
				chatGroupByOptions={botMode ? [] : undefined}
				chatView={view}
				collapsed={collapsed}
				dnd={dnd}
				label={sectionLabel}
				menu={menu}
				// New section and the imports live in the ⋯ menu, so the header
				// shows only "+" and "⋯" on hover.
				menuActions={[
					...(botMode && !managedProduct
						? [
								{
									icon: FolderAddIcon,
									id: "new-section",
									label: "New section",
									onSelect: openCreateSection,
								},
							]
						: []),
					...(onImport
						? [
								{
									icon: Upload01Icon,
									id: "import-thread",
									label: "Import a past agent thread",
									onSelect: onImport,
								},
							]
						: []),
					...(onImportSetup
						? [
								{
									icon: Settings03Icon,
									id: "import-setup",
									label: "Import agent setup from a folder",
									onSelect: onImportSetup,
								},
							]
						: []),
				]}
				onToggleCollapsed={onToggleCollapsed}
				pageSize={pageSize}
				sectionKey="chats"
				sort={sort}
				wrapHeader={(header) => (
					<DeleteAllChatsMenu
						// Only the chats the section's filters show, matching Projects.
						conversationIds={filteredLoose.map((c) => c.id)}
						groupLabel={sectionLabel}
						onDelete={handlers.onDeleteConversation}
						scope="all"
					>
						{header}
					</DeleteAllChatsMenu>
				)}
			>
				{botMode ? (
					<BotModeChatSectionsBody
						handlers={handlers}
						loose={filteredLoose}
						onAssignMany={botChatSections.assignConversations}
						onDelete={botChatSections.deleteSection}
						onNest={botChatSections.nestSection}
						onOpenRename={openRenameSection}
						sectionState={botChatSectionState}
						sections={botChatSections.sections}
						sessionSource={sessionSource}
					/>
				) : loose.length === 0 ? null : filteredLoose.length === 0 ? (
					<p className="flex h-8 items-center px-2 text-detail text-muted-foreground">
						No chats match the filters
					</p>
				) : view.groupBy === "default" || view.groupBy === "visibility" ? (
					orderedVisibilityGroups.map(renderVisibilityGroup)
				) : view.groupBy === "none" ? (
					<>
						<ChatRowList
							conversations={loosePaged.visible}
							handlers={handlers}
						/>
						<SectionPagingControls
							overflow={{
								getSearchText: (conversation) => conversation.title ?? "",
								items: loosePaged.items,
								label: "chats",
								renderList: (list) => (
									<ChatRowList conversations={list} handlers={handlers} />
								),
							}}
							paged={loosePaged}
						/>
					</>
				) : (
					<SidebarChatList
						conversations={sortedLoose}
						groupBy={view.groupBy}
						handlers={handlers}
						scope="loose"
					/>
				)}
			</SidebarSection>
			<BotChatSectionDialog
				initialName={sectionDialog?.initialName}
				mode={sectionDialog?.mode ?? "create"}
				onOpenChange={(open) => {
					if (!open) {
						setSectionDialog(null);
					}
				}}
				onSubmit={submitSectionDialog}
				open={sectionDialog !== null}
			/>
		</>
	);
}
