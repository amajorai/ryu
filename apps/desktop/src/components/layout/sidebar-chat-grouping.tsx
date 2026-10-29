import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenuCheckboxItem,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { createContext, useContext, useMemo } from "react";
import type { useBotChatSections } from "@/src/hooks/useBotChatSections.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	activeChatFilterCount,
	CHAT_ACTIVITY_LABELS,
	CHAT_ENVIRONMENT_LABELS,
	CHAT_GROUP_BY_OPTIONS,
	CHAT_STATUS_LABELS,
	type ChatClassifyContext,
	type ChatEnvironment,
	type ChatGroupBy,
	type ChatSectionView,
	type ChatStatus,
	chatActivitySchema,
	chatEnvironmentSchema,
	chatGroupBySchema,
	chatStatusSchema,
	emptyChatFilters,
	filterChats,
} from "./sidebar-chat-view.ts";

/** The "…" overflow menu shown in every section header: move the section up or
 *  down (relative to its visible neighbours), hide it, choose how many items to
 *  show before paginating, or open the customize dialog. */
export const ALL_CHAT_GROUP_BY: readonly ChatGroupBy[] =
	chatGroupBySchema.options;
export const PROJECT_CHAT_GROUP_BY: readonly ChatGroupBy[] =
	ALL_CHAT_GROUP_BY.filter((groupBy) => groupBy !== "project");

/** What the chat sections share for grouping and filtering: live classification
 *  inputs, names for groups, and the account-synced custom groups. */
export interface ChatGroupingValue {
	agents: readonly { id: string; name: string }[];
	classify: ChatClassifyContext;
	groups: ReturnType<typeof useBotChatSections>;
	/** The folder standing for a folder's project (see ChatGroupContext). */
	projectFolder?: (folderPath: string) => string;
	projectName: (folderPath: string) => string;
}

export const ChatGroupingContext = createContext<ChatGroupingValue | null>(
	null
);

const NO_CUSTOM_GROUPS: ReturnType<typeof useBotChatSections> = {
	assignConversation: () => undefined,
	assignConversations: () => undefined,
	assignments: {},
	createSection: () => null,
	deleteSection: () => undefined,
	nestSection: () => undefined,
	renameSection: () => undefined,
	sections: [],
};

function folderLeaf(folderPath: string): string {
	return (
		folderPath
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.at(-1) ?? folderPath
	);
}

/** The sidebar's grouping context, or a self-contained fallback for surfaces
 *  (stories, harnesses) that mount a chat list without the full sidebar. */
export function useChatGrouping(): ChatGroupingValue {
	const context = useContext(ChatGroupingContext);
	const unreadIds = useConversationFlagsStore((state) => state.unreadIds);
	const classify = useMemo(() => ({ unreadIds }), [unreadIds]);
	return (
		context ?? {
			agents: [],
			classify,
			groups: NO_CUSTOM_GROUPS,
			projectName: folderLeaf,
		}
	);
}

/** A section's chats after its filters. */
export function useFilteredChats(
	conversations: Conversation[],
	view: ChatSectionView | undefined
): Conversation[] {
	const { classify } = useChatGrouping();
	return useMemo(
		() =>
			view ? filterChats(conversations, view.filters, classify) : conversations,
		[conversations, view, classify]
	);
}

/** Groupings that replace paging with collapsible groups. */
export function isExplicitChatGrouping(
	groupBy: ChatGroupBy | undefined
): boolean {
	return groupBy !== undefined && groupBy !== "default" && groupBy !== "none";
}

function toggleIn<T>(list: readonly T[], value: T): T[] {
	return list.includes(value)
		? list.filter((item) => item !== value)
		: [...list, value];
}

/** Group by / Filter rows for a chat section's ⋯ menu. */
export function ChatViewMenuItems({
	groupByOptions,
	onChange,
	view,
}: {
	groupByOptions: readonly ChatGroupBy[];
	onChange: (view: ChatSectionView) => void;
	view: ChatSectionView;
}) {
	const tl = useLiteralMessages();
	const { agents } = useChatGrouping();
	const { filters } = view;
	const setFilters = (next: Partial<ChatSectionView["filters"]>) =>
		onChange({ ...view, filters: { ...filters, ...next } });
	const filterCount = activeChatFilterCount(filters);
	return (
		<>
			{groupByOptions.length > 0 ? (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>Group by</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuRadioGroup
							onValueChange={(value: string) => {
								const parsed = chatGroupBySchema.safeParse(value);
								if (parsed.success) {
									onChange({ ...view, groupBy: parsed.data });
								}
							}}
							value={view.groupBy}
						>
							{CHAT_GROUP_BY_OPTIONS.filter((option) =>
								groupByOptions.includes(option.value)
							).map((option) => (
								<DropdownMenuRadioItem key={option.value} value={option.value}>
									{option.label}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			) : null}
			<DropdownMenuSub>
				<DropdownMenuSubTrigger>
					{filterCount > 0
						? tl("Filter ({filterCount})", { filterCount })
						: "Filter"}
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="max-h-[70vh] overflow-y-auto">
					<DropdownMenuGroup>
						<DropdownMenuLabel>Status</DropdownMenuLabel>
						{chatStatusSchema.options.map((status: ChatStatus) => (
							<DropdownMenuCheckboxItem
								checked={filters.statuses.includes(status)}
								key={status}
								onCheckedChange={() =>
									setFilters({ statuses: toggleIn(filters.statuses, status) })
								}
							>
								{CHAT_STATUS_LABELS[status]}
							</DropdownMenuCheckboxItem>
						))}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuLabel>Environment</DropdownMenuLabel>
						{chatEnvironmentSchema.options.map(
							(environment: ChatEnvironment) => (
								<DropdownMenuCheckboxItem
									checked={filters.environments.includes(environment)}
									key={environment}
									onCheckedChange={() =>
										setFilters({
											environments: toggleIn(filters.environments, environment),
										})
									}
								>
									{CHAT_ENVIRONMENT_LABELS[environment]}
								</DropdownMenuCheckboxItem>
							)
						)}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							{tl("Activity: {activity}", {
								activity: CHAT_ACTIVITY_LABELS[filters.activity],
							})}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuRadioGroup
								onValueChange={(value: string) => {
									const parsed = chatActivitySchema.safeParse(value);
									if (parsed.success) {
										setFilters({ activity: parsed.data });
									}
								}}
								value={filters.activity}
							>
								{chatActivitySchema.options.map((activity) => (
									<DropdownMenuRadioItem key={activity} value={activity}>
										{CHAT_ACTIVITY_LABELS[activity]}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
					{agents.length > 0 ? (
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								{filters.agentIds.length > 0
									? tl("Agent ({agentCount})", {
											agentCount: filters.agentIds.length,
										})
									: "Agent"}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">
								{agents.map((agent) => (
									<DropdownMenuCheckboxItem
										checked={filters.agentIds.includes(agent.id)}
										key={agent.id}
										onCheckedChange={() =>
											setFilters({
												agentIds: toggleIn(filters.agentIds, agent.id),
											})
										}
									>
										<span className="truncate" data-ryu-i18n="off">
											{agent.name}
										</span>
									</DropdownMenuCheckboxItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					) : null}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={filterCount === 0}
						onClick={() => setFilters(emptyChatFilters())}
					>
						Clear filters
					</DropdownMenuItem>
				</DropdownMenuSubContent>
			</DropdownMenuSub>
		</>
	);
}
