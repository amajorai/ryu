import { FolderAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import {
	type BotChatSection,
	type BotChatSectionState,
	PROJECTS_SECTION_ID,
	sectionForConversation,
	UNORGANIZED_SECTION_ID,
} from "@/src/lib/bot-chat-sections.ts";
import { toEpoch } from "@/src/lib/sidebar/date-buckets.ts";
import type { Conversation } from "@/types/chat.ts";
import { BotChatSectionDialog } from "./BotChatSectionDialog.tsx";
import {
	type BotChatSectionDialogState,
	BotChatSectionMenu,
	botChatSectionMoveTargets,
	DeleteAllChatsMenu,
} from "./sidebar-bot-chat-sections.tsx";
import {
	isExplicitChatGrouping,
	useChatGrouping,
} from "./sidebar-chat-grouping.tsx";
import type { ChatMoveDrop } from "./sidebar-chat-selection.tsx";
import {
	type ChatGroup,
	type ChatGroupBy,
	type ChatGroupContext,
	groupChats,
} from "./sidebar-chat-view.ts";
import {
	ChatRowList,
	type ProjectBucket,
} from "./sidebar-conversation-list.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import { useNestedSections } from "./sidebar-nested-sections.ts";
import {
	conversationStamp,
	type SortAccessors,
} from "./sidebar-sort-paging.ts";
import {
	DateGroupedRows,
	dateBucketStorageKeys,
	SubSection,
} from "./sidebar-subsection.tsx";

// Per-project expand/collapse inside the single Projects section, persisted so a
// folder you opened stays open across reloads (independent of the Projects
// section's own collapse). Keyed by folder path.
export const PROJECT_EXPANDED_KEY = "ryu:sidebar-expanded-projects";

/** Sort projects by folder name or by the recency of their newest chat (empty
 *  projects sort to the bottom for the recency options). */
const PROJECT_SORT_ACCESSORS: SortAccessors<ProjectBucket> = {
	created: (p) =>
		p.conversations.reduce((max, c) => Math.max(max, toEpoch(c.createdAt)), 0),
	name: (p) => p.name,
	updated: (p) =>
		p.conversations.reduce((max, c) => Math.max(max, toEpoch(c.updatedAt)), 0),
};

/** Rank of a project with no chats for the "Status" sort: after every status. */
const EMPTY_PROJECT_STATUS_RANK = Number.MAX_SAFE_INTEGER;

/** Project accessors including the chat-only orders: a project ranks by its most
 *  urgent chat for "Status", and by its chats' message total for "Most
 *  messages". */
export function projectSortAccessors(
	chat: SortAccessors<Conversation>
): SortAccessors<ProjectBucket> {
	return {
		...PROJECT_SORT_ACCESSORS,
		messages: (p) =>
			p.conversations.reduce(
				(total, c) => total + (chat.messages?.(c) ?? 0),
				0
			),
		statusRank: (p) =>
			p.conversations.reduce(
				(min, c) => Math.min(min, chat.statusRank?.(c) ?? min),
				EMPTY_PROJECT_STATUS_RANK
			),
	};
}

/** Display label of a custom group for chat grouping (the built-in buckets read
 *  as catch-alls here, not as the bot-mode "Projects" / "Chats" sections). */
function customGroupLabel(
	groupId: string,
	sections: readonly BotChatSection[]
): string {
	if (groupId === UNORGANIZED_SECTION_ID) {
		return "Ungrouped";
	}
	if (groupId === PROJECTS_SECTION_ID) {
		return "Project threads";
	}
	return sections.find((section) => section.id === groupId)?.name ?? "Group";
}

/**
 * Chats split into collapsible, drag-reorderable groups by status, project,
 * agent, environment, visibility, or the user's custom groups. Custom and project
 * groups are also drop targets: dropping a chat files it into that group.
 */
function ChatGroupedRows({
	conversations,
	groupBy,
	handlers,
	scope,
}: {
	conversations: Conversation[];
	groupBy: ChatGroupBy;
	handlers: ChatRowHandlers;
	scope: string;
}) {
	const grouping = useChatGrouping();
	const { groups: customGroups } = grouping;
	const customState = useMemo<BotChatSectionState>(
		() => ({
			assignments: customGroups.assignments,
			sections: customGroups.sections,
		}),
		[customGroups.assignments, customGroups.sections]
	);
	const groupContext: ChatGroupContext = {
		...grouping.classify,
		agentName: (agentId) =>
			grouping.agents.find((agent) => agent.id === agentId)?.name ??
			agentId.split("/").pop() ??
			agentId,
		customGroupOf: (conversation) => {
			const id = sectionForConversation(customState, conversation);
			return { id, label: customGroupLabel(id, customState.sections) };
		},
		customGroups: [
			...customState.sections.map((section) => ({
				id: section.id,
				label: section.name,
			})),
			{ id: UNORGANIZED_SECTION_ID, label: "Ungrouped" },
		],
		projectFolder: grouping.projectFolder,
		projectName: grouping.projectName,
	};
	const groups = groupChats(conversations, groupBy, groupContext);
	const groupByKey = new Map<string, ChatGroup>(groups.map((g) => [g.key, g]));
	// A stable key list across row updates, so group order state only reacts when
	// the set of groups actually changes.
	const keySignature = groups.map((group) => group.key).join("\n");
	const groupKeys = useMemo(
		() => (keySignature ? keySignature.split("\n") : []),
		[keySignature]
	);
	const storageScope = `${scope}:${groupBy}`;
	const nested = useNestedSections(
		`ryu:sidebar-chat-group-order:${storageScope}`,
		`ryu:sidebar-chat-group-collapsed:${storageScope}`,
		groupKeys,
		false
	);
	const [dialog, setDialog] = useState<BotChatSectionDialogState | null>(null);

	const dropFor = (group: ChatGroup): ChatMoveDrop | undefined => {
		if (groupBy === "custom") {
			const groupId = group.key.slice("custom:".length);
			return {
				accepts: (ids) =>
					ids.some((id) => sectionForConversation(customState, id) !== groupId),
				onDrop: (ids) => customGroups.assignConversations(ids, groupId),
			};
		}
		if (groupBy === "project") {
			// The group's real folder path: its key is normalized for comparison.
			return handlers.bulk?.dropTarget({
				folderPath: group.folderPath ?? null,
				kind: "folder",
			});
		}
		return undefined;
	};

	return (
		<div className="ml-2 space-y-0.5">
			{nested.orderedKeys.map((key) => {
				const group = groupByKey.get(key);
				if (!group) {
					return null;
				}
				const customSection =
					groupBy === "custom"
						? customState.sections.find(
								(section) => `custom:${section.id}` === key
							)
						: undefined;
				return (
					<SubSection
						action={
							customSection ? (
								<BotChatSectionMenu
									label={customSection.name}
									moveTargets={botChatSectionMoveTargets(
										customState,
										customSection.id
									)}
									onDelete={() => customGroups.deleteSection(customSection.id)}
									onMove={(parentId) =>
										customGroups.nestSection(customSection.id, parentId)
									}
									onRename={() =>
										setDialog({
											id: customSection.id,
											initialName: customSection.name,
											mode: "rename",
										})
									}
								/>
							) : undefined
						}
						chatDrop={dropFor(group)}
						collapsed={nested.isCollapsed(key)}
						count={group.items.length}
						dnd={nested.dnd}
						key={key}
						label={group.label}
						onToggleCollapsed={nested.toggle}
						sectionKey={key}
						testId={`sidebar-chat-group-${key}`}
						wrapHeader={(header) => (
							<DeleteAllChatsMenu
								conversationIds={group.items.map((c) => c.id)}
								groupLabel={group.label}
								onDelete={handlers.onDeleteConversation}
								scope="group"
							>
								{header}
							</DeleteAllChatsMenu>
						)}
					>
						{group.items.length > 0 ? (
							<ChatRowList conversations={group.items} handlers={handlers} />
						) : (
							<p className="px-2 py-1 text-muted-foreground/70 text-xs">
								Drop chats here
							</p>
						)}
					</SubSection>
				);
			})}
			{groupBy === "custom" ? (
				<button
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-muted-foreground text-xs transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-foreground hover:duration-0"
					onClick={() =>
						setDialog({ id: null, initialName: "", mode: "create" })
					}
					type="button"
				>
					<HugeiconsIcon className="size-3.5" icon={FolderAddIcon} />
					New group
				</button>
			) : null}
			<BotChatSectionDialog
				initialName={dialog?.initialName}
				mode={dialog?.mode ?? "create"}
				onOpenChange={(open) => {
					if (!open) {
						setDialog(null);
					}
				}}
				onSubmit={(name) => {
					if (!dialog) {
						return;
					}
					if (dialog.mode === "create") {
						customGroups.createSection(name);
					} else {
						customGroups.renameSection(dialog.id, name);
					}
				}}
				open={dialog !== null}
			/>
		</div>
	);
}

/**
 * Any run of chats in the sidebar, date-bucketed when the user's "Group lists by
 * date" setting is on and flat otherwise.
 *
 * This is what makes the setting universal rather than Chats-only. Every chat list
 * outside the Chats section itself goes through here — an expanded project row, the
 * picker's "All projects" and single-project bodies, Pinned, Archived — so date
 * grouping cannot be on in one place and quietly missing in another.
 *
 * `scope` namespaces the bucket collapse/order state: collapsing "Older" under one
 * project must not collapse it under every other one, nor under Pinned.
 */
export function SidebarChatList({
	conversations,
	groupBy = "default",
	handlers,
	scope,
}: {
	conversations: Conversation[];
	/** The section's Group by choice; `default` follows "Group lists by date". */
	groupBy?: ChatGroupBy;
	handlers: ChatRowHandlers;
	scope: string;
}) {
	const [groupByDateSetting] = useChatDateGrouping();
	const storage = dateBucketStorageKeys(`chats:${scope}`);
	const renderRows = (list: Conversation[]) => (
		<ChatRowList conversations={list} handlers={handlers} />
	);
	if (isExplicitChatGrouping(groupBy) && groupBy !== "date") {
		return (
			<ChatGroupedRows
				conversations={conversations}
				groupBy={groupBy}
				handlers={handlers}
				// Remount per scope + grouping so each keeps its own collapse/order.
				key={`${scope}:${groupBy}`}
				scope={scope}
			/>
		);
	}
	const groupByDate =
		groupBy === "date" || (groupBy === "default" && groupByDateSetting);
	if (!groupByDate) {
		return renderRows(conversations);
	}
	return (
		<DateGroupedRows
			className="ml-2 space-y-0.5"
			collapsedKey={storage.collapsedKey}
			items={conversations}
			// REMOUNT on a scope change. `useNestedSections` loads both storage keys in
			// `useState` initializers only, and this element keeps its tree position
			// when the picker switches project — so without a changing key the buckets
			// would carry the previous scope's collapse set and the next toggle would
			// write it to the NEW scope's key, which is the exact cross-contamination
			// the per-scope keys exist to prevent.
			key={storage.orderKey}
			orderKey={storage.orderKey}
			renderRows={renderRows}
			stampOf={conversationStamp}
			wrapHeader={(bucket, header) => (
				<DeleteAllChatsMenu
					conversationIds={bucket.items.map((c) => c.id)}
					groupLabel={bucket.label}
					onDelete={handlers.onDeleteConversation}
					scope="group"
				>
					{header}
				</DeleteAllChatsMenu>
			)}
		/>
	);
}
