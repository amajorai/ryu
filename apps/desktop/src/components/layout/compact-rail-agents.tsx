import {
	PencilEdit01Icon,
	PinIcon,
	PinOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useMemo } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { groupDirectAgentThreads } from "@/src/lib/agent-conversation-groups.ts";
import {
	AgentAvatar,
	engineForAgent,
	personaToGlyph,
} from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import {
	activeRailAgentId,
	agentsWithUnread,
	railAgentGroups,
} from "@/src/lib/compact-rail.ts";
import { useFavorites } from "@/src/lib/library.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";

/** A short divider between the rail's groups. */
export function RailDivider() {
	return (
		<hr aria-hidden className="my-1 h-px w-8 shrink-0 border-0 bg-border" />
	);
}

function RailAgentButton({
	active,
	agent,
	onEdit,
	onOpen,
	onTogglePin,
	pinned,
	unread,
}: {
	active: boolean;
	agent: AgentSummary;
	onEdit: () => void;
	onOpen: () => void;
	onTogglePin: () => void;
	pinned: boolean;
	unread: boolean;
}) {
	const label = unread ? `${agent.name} (unread)` : agent.name;
	return (
		<ContextMenu>
			<ContextMenuTrigger className="relative flex w-full shrink-0 justify-center">
				{/* The active marker hugs the window edge, the way a messaging app
				    marks the open conversation without crowding the avatar. */}
				<span
					aria-hidden
					className={cn(
						"absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-[height,opacity] duration-200",
						active ? "h-6 opacity-100" : "h-2 opacity-0"
					)}
				/>
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								aria-current={active ? "page" : undefined}
								aria-label={label}
								className={cn(
									"relative flex size-12 items-center justify-center rounded-2xl transition-colors hover:bg-sidebar-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60",
									active && "bg-sidebar-accent ring-1 ring-sidebar-border"
								)}
								data-agent-id={agent.id}
								onClick={onOpen}
								type="button"
							>
								<AgentAvatar
									avatarUrl={agent.avatarUrl}
									className="shrink-0 object-cover"
									engine={engineForAgent(agent)}
									glyph={agent.avatarGlyph}
									presentation="compact"
									size="36px"
								/>
								{unread ? (
									<span
										aria-hidden
										className="absolute top-1 right-1 size-2.5 rounded-full bg-primary ring-2 ring-background"
										data-testid="compact-rail-unread"
									/>
								) : null}
							</button>
						}
					/>
					<TooltipContent side="right">{agent.name}</TooltipContent>
				</Tooltip>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={onEdit}>
					<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
					Edit agent
				</ContextMenuItem>
				<ContextMenuItem onClick={onTogglePin}>
					<HugeiconsIcon
						className="mr-2 size-4"
						icon={pinned ? PinOffIcon : PinIcon}
					/>
					{pinned ? "Unpin agent" : "Pin agent"}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

/**
 * The rail's roster: pinned agents first, everyone else below a divider.
 *
 * A tap opens the merged per-agent chat (`/chat/agent/<id>`), the same view the
 * messaging-style sidebar rows open, so tapping an agent twice returns to the
 * same tab rather than stacking new chats.
 */
export function CompactRailAgents() {
	const { agents } = useAgents();
	const { favorites, toggle: toggleFavorite } = useFavorites();
	const { conversations } = useChatHistoryContext();
	const unreadIds = useConversationFlagsStore((state) => state.unreadIds);
	const openTab = useTabSelector((state) => state.openTab);
	const activeTab = useTabSelector((state) =>
		state.tabs.find((tab) => tab.id === state.activeTabId)
	);

	const pinnedIds = useMemo(
		() =>
			favorites
				.filter((favorite) => favorite.type === "agent")
				.map((favorite) => favorite.id),
		[favorites]
	);
	const { pinned, others } = useMemo(
		() => railAgentGroups(agents, pinnedIds),
		[agents, pinnedIds]
	);
	const unreadAgents = useMemo(
		() => agentsWithUnread(groupDirectAgentThreads(conversations), unreadIds),
		[conversations, unreadIds]
	);
	const activeAgentId = activeRailAgentId(activeTab, conversations);
	const pinnedSet = new Set(pinnedIds);

	const openAgentChat = (agent: AgentSummary) => {
		openTab(`/chat/agent/${encodeURIComponent(agent.id)}`, {
			title: agent.name,
			icon: agent.avatarGlyph ?? personaToGlyph({ avatarUrl: agent.avatarUrl }),
		});
	};
	const editAgent = (agent: AgentSummary) => {
		openTab(`/agents/${agent.id}/edit`, {
			title: agent.name,
			icon: agent.avatarGlyph ?? personaToGlyph({ avatarUrl: agent.avatarUrl }),
		});
	};

	const renderAgent = (agent: AgentSummary) => (
		<RailAgentButton
			active={agent.id === activeAgentId}
			agent={agent}
			key={agent.id}
			onEdit={() => editAgent(agent)}
			onOpen={() => openAgentChat(agent)}
			onTogglePin={() => toggleFavorite("agent", agent.id)}
			pinned={pinnedSet.has(agent.id)}
			unread={unreadAgents.has(agent.id)}
		/>
	);

	return (
		<>
			{pinned.map(renderAgent)}
			{pinned.length > 0 && others.length > 0 ? <RailDivider /> : null}
			{others.map(renderAgent)}
		</>
	);
}
