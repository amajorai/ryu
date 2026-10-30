import {
	ArrowUpRight01Icon,
	GitBranchIcon,
	PencilEdit01Icon,
	PinIcon,
	PinOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useMemo, useState } from "react";
import { UsageBar } from "@/components/agent-elements/input/usage-bar.tsx";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentRowStyle } from "@/src/hooks/useAgentRowStyle.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useUsageBarPrefs } from "@/src/hooks/useUsageBarPrefs.ts";
import { groupDirectAgentThreads } from "@/src/lib/agent-conversation-groups.ts";
import {
	AgentAvatar,
	engineForAgent,
	personaToGlyph,
} from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { useFavorites } from "@/src/lib/library.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";
import type { Conversation } from "@/types/chat.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { PinnedAgentStage } from "./pinned-agent-stage.tsx";
import {
	AgentThreadRow,
	latestConversationByAgent,
	MessagingAgentRowBody,
} from "./sidebar-agent-rows.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import {
	SectionAddButton,
	type SectionProps,
	SidebarSection,
} from "./sidebar-section.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import {
	chatSearchText,
	NAMED_SORT_ACCESSORS,
	sortItems,
	usePaged,
} from "./sidebar-sort-paging.ts";
import { EntityRowGlyph, useContributedRowsFor } from "./tab-entity-menu.tsx";

/** A branch-tree list beneath one bot in Bot mode. Forked conversations are
 *  ordinary Core summaries, so a new fork appears here as soon as the history
 *  context receives the fork response; no second thread registry is needed. */
export function AgentThreadList({
	loadMessages,
	nodeUrl,
	onMarkRead,
	onMarkUnread,
	onOpen,
	onOpenQuickPreview,
	onOpenQuickReply,
	pageSize,
	threads,
	unreadIds,
}: {
	loadMessages?: ChatRowHandlers["loadMessages"];
	nodeUrl?: string;
	onMarkRead?: ChatRowHandlers["onMarkRead"];
	onMarkUnread?: ChatRowHandlers["onMarkUnread"];
	onOpen: (conversationId: string) => void;
	onOpenQuickPreview?: ChatRowHandlers["onOpenQuickPreview"];
	onOpenQuickReply?: ChatRowHandlers["onOpenQuickReply"];
	pageSize: number;
	threads: Conversation[];
	unreadIds?: Set<string>;
}) {
	const paged = usePaged(threads, pageSize);
	const renderList = (list: Conversation[]) => (
		<div className="relative ml-5 border-border border-l pl-2">
			<SidebarMenu>
				{list.map((thread) => (
					<AgentThreadRow
						key={thread.id}
						loadMessages={loadMessages}
						nodeUrl={nodeUrl}
						onMarkRead={onMarkRead}
						onMarkUnread={onMarkUnread}
						onOpen={onOpen}
						onOpenQuickPreview={onOpenQuickPreview}
						onOpenQuickReply={onOpenQuickReply}
						thread={thread}
						unreadIds={unreadIds}
					/>
				))}
			</SidebarMenu>
		</div>
	);

	return (
		<div className="mt-0.5" data-testid="agent-thread-list">
			<div className="flex h-7 items-center gap-1.5 px-2 pl-7 text-detail text-muted-foreground">
				<HugeiconsIcon className="size-3.5" icon={GitBranchIcon} />
				<span>Threads</span>
				<span className="text-muted-foreground/70 text-xs tabular-nums">
					{formatCount(threads.length)}
				</span>
			</div>
			{renderList(paged.visible)}
			<SectionPagingControls
				overflow={{
					getSearchText: chatSearchText,
					items: paged.items,
					label: "threads",
					renderList,
				}}
				paged={paged}
			/>
		</div>
	);
}

/** Agents list in the sidebar — single-line rows, each with the Ryu logo. */
export function AgentsSection({
	collapsed,
	dnd,
	menu,
	onOpenQuickPreview,
	onOpenQuickReply,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const tl = useLiteralMessages();
	const { openCreateAgent } = useCreateAgentDialog();
	const openTab = useTabSelector((state) => state.openTab);
	const { agents, loading } = useAgents();
	// App-contributed rows anchored to `agent`. The sidebar is where agents are
	// listed, so an app anchoring here previously had its row reachable only from
	// an agent TAB's menu — the one surface you have to already be on the agent to
	// see. Same factory the tab menu uses, so the two cannot drift.
	const agentContributedRows = useContributedRowsFor("agent", "agent_id");
	const usageBarPrefs = useUsageBarPrefs();
	const rowStyle = useAgentRowStyle();
	const messaging = rowStyle === "messaging";
	const { favorites, toggle: toggleFavorite } = useFavorites();
	const { conversations, loadMessages } = useChatHistoryContext();
	const activeNode = useActiveNode();
	const unreadIds = useConversationFlagsStore((state) => state.unreadIds);
	const markRead = useConversationFlagsStore((state) => state.markRead);
	const markUnread = useConversationFlagsStore((state) => state.markUnread);
	const pinnedAgents = useMemo(() => {
		const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
		return favorites
			.filter((favorite) => favorite.type === "agent")
			.map((favorite) => agentsById.get(favorite.id))
			.filter((agent): agent is AgentSummary => agent !== undefined);
	}, [agents, favorites]);
	const pinnedAgentIds = useMemo(
		() => new Set(pinnedAgents.map((agent) => agent.id)),
		[pinnedAgents]
	);
	// Bot mode gives pinned agents their own visual priority shelf. In every other
	// sidebar arrangement the regular agent list remains complete, so a pin never
	// makes an agent disappear just because the user left Bot mode.
	const listedAgents = messaging
		? agents.filter((agent) => !pinnedAgentIds.has(agent.id))
		: agents;
	// Only the messaging rows read this, and it walks every conversation — skip
	// the work entirely while the compact rows are on.
	const latestByAgent = useMemo(
		() =>
			messaging
				? latestConversationByAgent(conversations)
				: new Map<string, Conversation>(),
		[messaging, conversations]
	);
	const directThreadsByAgent = useMemo(
		() => groupDirectAgentThreads(conversations),
		[conversations]
	);
	const [expandedAgentIds, setExpandedAgentIds] = useState<Set<string>>(
		new Set()
	);
	const paged = usePaged(
		sortItems(listedAgents, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openAgent = (id: string, name: string, forceNew = false) => {
		const agent = agents.find((a) => a.id === id);
		openTab(`/agents/${id}/edit`, {
			title: name,
			forceNew,
			icon:
				agent?.avatarGlyph ?? personaToGlyph({ avatarUrl: agent?.avatarUrl }),
		});
	};

	const openAgentInNewWindow = (id: string, name: string) => {
		void openEntityInNewWindow({ path: `/agents/${id}/edit`, title: name });
	};

	// Start a fresh chat with this agent pre-selected (ChatPage reads initialAgent).
	//
	// Messaging rows open the merged view instead: one scroll holding every thread
	// with this agent, the way tapping a contact does. That path is a singleton per
	// agent, so tapping the same agent twice returns to the same tab rather than
	// piling up empty chats.
	const startChatWithAgent = (id: string) => {
		const agent = agents.find((a) => a.id === id);
		const icon =
			agent?.avatarGlyph ?? personaToGlyph({ avatarUrl: agent?.avatarUrl });
		if (messaging) {
			openTab(`/chat/agent/${encodeURIComponent(id)}`, {
				title: agent?.name,
				icon,
			});
			return;
		}
		openTab("/chat", {
			forceNew: true,
			initialAgent: id,
			icon,
		});
	};

	const toggleAgentThreads = (agentId: string) => {
		setExpandedAgentIds((current) => {
			const next = new Set(current);
			if (next.has(agentId)) {
				next.delete(agentId);
			} else {
				next.add(agentId);
			}
			return next;
		});
	};

	const openThread = (conversationId: string) => {
		openTab("/chat", { conversationId });
	};

	const renderAgentRows = (list: typeof agents) =>
		list.map((agent) => {
			const threads = directThreadsByAgent.get(agent.id) ?? [];
			const threadsExpanded = expandedAgentIds.has(agent.id);
			return (
				<SidebarMenuItem key={agent.id}>
					<ContextMenu>
						<ContextMenuTrigger>
							{/* sidebar row combines nested controls with drag/middle-click */}
							<div
								className={
									messaging
										? "group/row relative flex h-8 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 text-sm transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0"
										: "group/row flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0"
								}
								onAuxClick={(e) => {
									if (e.button === 1) {
										e.preventDefault();
										openAgent(agent.id, agent.name, true);
									}
								}}
								onClick={() => startChatWithAgent(agent.id)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										startChatWithAgent(agent.id);
									}
								}}
								role="button"
								tabIndex={0}
							>
								{messaging ? (
									<MessagingAgentRowBody
										agent={agent}
										conversation={latestByAgent.get(agent.id)}
										loadMessages={loadMessages}
										nodeUrl={activeNode.url}
										onEdit={() => openAgent(agent.id, agent.name)}
										onToggleThreads={() => toggleAgentThreads(agent.id)}
										threadCount={threads.length}
										threadsExpanded={threadsExpanded}
										usageBarVisible={usageBarPrefs.sidebar}
									/>
								) : (
									<>
										<AgentAvatar
											className="size-4 shrink-0"
											engine={engineForAgent(agent)}
											glyph={agent.avatarGlyph}
											presentation="compact"
											size="16px"
										/>
										<div
											className="flex min-w-0 shrink items-center gap-1.5"
											data-ryu-i18n="off"
										>
											<OverflowTooltip
												className="min-w-0 overflow-hidden whitespace-nowrap text-sm"
												fade
												text={agent.name}
											/>
										</div>
										{usageBarPrefs.sidebar ? (
											<UsageBar
												agentId={agent.id}
												className="shrink-0"
												visible={usageBarPrefs.sidebar}
											/>
										) : null}
										<div aria-hidden="true" className="flex-1" />
										<Tooltip>
											<TooltipTrigger
												render={
													<Button
														aria-label={tl("Edit {name}", { name: agent.name })}
														className="size-6 rounded-lg opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/row:opacity-100 group-hover/row:duration-0"
														onClick={(e) => {
															e.stopPropagation();
															openAgent(agent.id, agent.name);
														}}
														size="icon-xs"
														type="button"
														variant="ghost-muted"
													>
														<HugeiconsIcon
															className="size-3.5"
															icon={PencilEdit01Icon}
														/>
													</Button>
												}
											/>
											<TooltipContent>Edit agent</TooltipContent>
										</Tooltip>
									</>
								)}
							</div>
						</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuItem
								onClick={() => openAgent(agent.id, agent.name, true)}
							>
								<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
								Open in new tab
							</ContextMenuItem>
							<OpenInNewWindowContextMenuItem
								onClick={() => openAgentInNewWindow(agent.id, agent.name)}
							/>
							<ContextMenuItem
								onClick={() => toggleFavorite("agent", agent.id)}
							>
								<HugeiconsIcon
									className="size-4"
									icon={pinnedAgentIds.has(agent.id) ? PinOffIcon : PinIcon}
								/>
								{pinnedAgentIds.has(agent.id) ? "Unpin agent" : "Pin agent"}
							</ContextMenuItem>
							{agentContributedRows(agent.id).map((row) => (
								<ContextMenuItem key={row.id} onClick={row.onSelect}>
									<span className="inline-flex">
										<EntityRowGlyph row={row} />
									</span>
									{row.label}
								</ContextMenuItem>
							))}
						</ContextMenuContent>
					</ContextMenu>
					{messaging && threadsExpanded ? (
						<AgentThreadList
							loadMessages={loadMessages}
							nodeUrl={activeNode.url}
							onMarkRead={markRead}
							onMarkUnread={markUnread}
							onOpen={openThread}
							onOpenQuickPreview={onOpenQuickPreview}
							onOpenQuickReply={onOpenQuickReply}
							pageSize={pageSize}
							threads={threads}
							unreadIds={unreadIds}
						/>
					) : null}
				</SidebarMenuItem>
			);
		});

	// An empty Agents group is hidden outright; "New agent" stays in the
	// account menu's New submenu. While the list loads, the header shows alone.
	if (agents.length === 0 && !loading) {
		return null;
	}

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openCreateAgent()} title="New agent" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Agents"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="agents"
			sort={sort}
		>
			{agents.length === 0 ? null : (
				<>
					{messaging ? (
						<PinnedAgentStage
							agents={pinnedAgents}
							onEdit={(agent) => openAgent(agent.id, agent.name)}
							onOpen={(agent) => startChatWithAgent(agent.id)}
							onUnpin={(agent) => toggleFavorite("agent", agent.id)}
						/>
					) : null}
					{messaging && pinnedAgents.length > 0 && listedAgents.length > 0 ? (
						<div className="flex h-7 items-center px-2 text-detail text-muted-foreground">
							Other agents
						</div>
					) : null}
					{listedAgents.length > 0 ? (
						<>
							<SidebarMenu>{renderAgentRows(paged.visible)}</SidebarMenu>
							<SectionPagingControls
								overflow={{
									getSearchText: (agent) => agent.name ?? "",
									items: paged.items,
									label: "agents",
									renderList: (list) => (
										<SidebarMenu>{renderAgentRows(list)}</SidebarMenu>
									),
								}}
								paged={paged}
							/>
						</>
					) : null}
				</>
			)}
		</SidebarSection>
	);
}

/** A section's load-failure body: a plain-English line plus a "Try again"
 *  affordance. Shown instead of the empty-state when a fetch fails, so a failed
 *  load never masquerades as "nothing here yet". */
export function SectionLoadError({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<div className="flex flex-col items-start gap-1 px-2 py-2">
			<p className="text-detail text-muted-foreground">{message}</p>
			<Button onClick={onRetry} size="xs" type="button" variant="outline">
				Try again
			</Button>
		</div>
	);
}
