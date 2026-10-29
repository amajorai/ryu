// apps/desktop/src/components/layout/AllComputersSidebar.tsx
//
// The "All computers" sidebar mode: one collapsible group per configured
// computer, the default one first.
//
// - The DEFAULT computer's group renders the ordinary Pinned / Projects / Chats
//   sections (`renderLocalSections`), with every handler they already have.
// - Every OTHER computer's group is a read-only list from that computer's own
//   `GET /api/conversations` (`useNodeConversations`). Rename, delete, pin, move
//   and fork are bound to the default computer's authority in the regular rows,
//   so they are not offered here; opening the thread (a tab bound to that
//   computer) is where it is managed.
// - A computer that goes offline stays listed. Its last-known threads (memory
//   only, this session) are greyed and disabled; on a cold start with it offline
//   the group says so instead of disappearing.
// - Remote rows ignore the local pinned / archived / unread flags: those are
//   keyed by conversation id alone, and after a handoff the same id can exist
//   on two computers.
//
// Built from `@ryu/ui` sidebar primitives directly (never from AppSidebar) so
// the two modules never import each other.

import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowRight01Icon,
	Folder01Icon,
	LaptopIcon,
	LinkSquare02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarMenu,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils.ts";
import { ContinuedOnBadge } from "@/src/components/chat/ContinuedOnBanner.tsx";
import { nodeSettingsLabel } from "@/src/components/gateway/GatewayNodeScopePicker.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import {
	nodeConversationsQueryKey,
	useNodeConversations,
} from "@/src/hooks/useNodeConversations.ts";
import {
	setNodeTabOverride,
	useNodeTabOverride,
} from "@/src/hooks/useNodeDisplayMode.ts";
import { useNodeOnline } from "@/src/hooks/useNodeOnline.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	clearRnpContinued,
	workspaceErrorMessage,
} from "@/src/lib/api/continuity-workspace.ts";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import { compactAge } from "@/src/lib/time.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { NodeStatusDot } from "./NodeStatusDot.tsx";
import { OpenInNewWindowContextMenuItem } from "./OpenInNewWindowMenuItem.tsx";

/** Per-viewer collapse state: the names of collapsed computer groups. */
export const COMPUTERS_COLLAPSED_KEY = "ryu:sidebar-computers-collapsed";

function readCollapsed(): Set<string> {
	try {
		const raw = localStorage.getItem(COMPUTERS_COLLAPSED_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return new Set(
			Array.isArray(parsed)
				? parsed.filter((name): name is string => typeof name === "string")
				: []
		);
	} catch {
		return new Set();
	}
}

function writeCollapsed(collapsed: ReadonlySet<string>): void {
	try {
		localStorage.setItem(
			COMPUTERS_COLLAPSED_KEY,
			JSON.stringify([...collapsed])
		);
	} catch {
		// Collapse state is a convenience; an unavailable store just forgets it.
	}
}

const PATH_SEP_RE = /[\\/]/;
const TRAILING_SEPARATORS_RE = /[\\/]+$/;

/** Folder leaf as a label. Another computer's paths are never matched against
 *  this computer's projects (a Windows path seen from a Mac means nothing
 *  here), so the folder's own name is the only honest label. */
function folderLeaf(path: string): string {
	const trimmed = path.replace(TRAILING_SEPARATORS_RE, "");
	return trimmed.split(PATH_SEP_RE).pop() || trimmed || path;
}

export interface RemoteFolderGroup {
	conversations: Conversation[];
	key: string;
	name: string;
}

/** Group a remote computer's threads by folder; folderless threads are loose.
 *  Spawned sessions are left out, as they are behind their main thread in the
 *  regular sidebar. Newest first within each bucket. */
export function groupRemoteThreads(conversations: readonly Conversation[]): {
	folders: RemoteFolderGroup[];
	loose: Conversation[];
} {
	const byNewest = [...conversations]
		.filter((c) => !c.hierarchy?.spawnedByConversationId)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const folders = new Map<string, RemoteFolderGroup>();
	const loose: Conversation[] = [];
	for (const conversation of byNewest) {
		if (!conversation.folderPath) {
			loose.push(conversation);
			continue;
		}
		const key = conversation.folderPath.replace(TRAILING_SEPARATORS_RE, "");
		const bucket = folders.get(key);
		if (bucket) {
			bucket.conversations.push(conversation);
		} else {
			folders.set(key, {
				key,
				name: folderLeaf(conversation.folderPath),
				conversations: [conversation],
			});
		}
	}
	return { folders: [...folders.values()], loose };
}

interface ComputerGroupHeaderProps {
	collapsed: boolean;
	/** Why "+" cannot start a chat here; `null` = it can. */
	newChatDisabledReason?: string | null;
	node: Node;
	online: boolean | null;
	onNewChat: () => void;
	onToggle: () => void;
}

function ComputerGroupHeader({
	collapsed,
	newChatDisabledReason = null,
	node,
	online,
	onNewChat,
	onToggle,
}: ComputerGroupHeaderProps) {
	const label = nodeSettingsLabel(node);
	const newChatDisabled = newChatDisabledReason !== null;
	return (
		<div className="group/computer flex h-8 items-center gap-1 px-1">
			<button
				aria-expanded={!collapsed}
				className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left font-medium text-sidebar-foreground text-sm outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
				onClick={onToggle}
				type="button"
			>
				<HugeiconsIcon
					className="shrink-0 text-muted-foreground"
					icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
					size={12}
				/>
				<NodeStatusDot online={online} />
				<span className="min-w-0 truncate">{label}</span>
				{node.managed ? (
					<span className="type-micro shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-medium text-accent-foreground">
						Cloud
					</span>
				) : null}
			</button>
			<Button
				aria-disabled={newChatDisabled || undefined}
				aria-label={`New chat on ${label}`}
				className={newChatDisabled ? "cursor-default opacity-60" : undefined}
				data-testid={`computers-new-chat-${node.name}`}
				onClick={() => {
					if (!newChatDisabled) {
						onNewChat();
					}
				}}
				size="icon-xs"
				title={newChatDisabledReason ?? undefined}
				variant="ghost"
			>
				<HugeiconsIcon icon={Add01Icon} size={14} />
			</Button>
		</div>
	);
}

interface RemoteThreadRowProps {
	conversation: Conversation;
	disabledReason: string | null;
	node: Node;
}

function RemoteThreadRow({
	conversation,
	disabledReason,
	node,
}: RemoteThreadRowProps) {
	const openTab = useTabSelector((state) => state.openTab);
	const queryClient = useQueryClient();
	const status = conversationRunStatusMeta(conversation.runStatus);
	const disabled = disabledReason !== null;
	const open = (forceNew: boolean) =>
		openTab("/chat", {
			conversationId: conversation.id,
			forceNew,
			icon: conversation.icon ?? null,
			node: node.name,
			title: conversation.title,
		});
	// Clear this computer's "Continued on" marker so it owns the thread again.
	// The regular rows only reach the default computer; this is the same action
	// for a thread whose copy lives on another computer.
	const takeBack = () => {
		const pending = clearRnpContinued(toTarget(node), conversation.id).then(
			() =>
				queryClient.invalidateQueries({
					queryKey: nodeConversationsQueryKey(node),
				})
		);
		toast.promise(pending, {
			loading: "Taking the thread back…",
			success: "Thread taken back",
			error: (cause: unknown) =>
				workspaceErrorMessage(cause, "Could not take the thread back"),
		});
	};
	const row = (
		<button
			aria-disabled={disabled || undefined}
			className={cn(
				"flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring",
				disabled
					? "cursor-default opacity-60"
					: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
			)}
			data-testid={`computers-thread-${node.name}-${conversation.id}`}
			onAuxClick={(event) => {
				if (event.button === 1 && !disabled) {
					event.preventDefault();
					open(true);
				}
			}}
			onClick={() => {
				if (!disabled) {
					open(false);
				}
			}}
			title={disabledReason ?? undefined}
			type="button"
		>
			{status ? (
				<span
					aria-label={status.label}
					className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)}
					role="img"
				/>
			) : null}
			<span className="min-w-0 flex-1 truncate">{conversation.title}</span>
			{conversation.continuedOn ? (
				<ContinuedOnBadge continuedOn={conversation.continuedOn} />
			) : null}
			<span className="type-micro shrink-0 text-muted-foreground tabular-nums">
				{compactAge(conversation.updatedAt)}
			</span>
		</button>
	);
	if (disabled) {
		return <SidebarMenuItem>{row}</SidebarMenuItem>;
	}
	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger render={row} />
				<ContextMenuContent>
					<ContextMenuItem onClick={() => open(false)}>Open</ContextMenuItem>
					<ContextMenuItem onClick={() => open(true)}>
						<HugeiconsIcon className="mr-2 size-4" icon={LinkSquare02Icon} />
						Open in new tab
					</ContextMenuItem>
					<OpenInNewWindowContextMenuItem
						onClick={() => {
							void openEntityInNewWindow({
								conversationId: conversation.id,
								node: node.name,
								path: "/chat",
								title: conversation.title,
							});
						}}
					/>
					{conversation.continuedOn ? (
						<ContextMenuItem onClick={takeBack}>
							<HugeiconsIcon className="mr-2 size-4" icon={LaptopIcon} />
							Take back here
						</ContextMenuItem>
					) : null}
				</ContextMenuContent>
			</ContextMenu>
		</SidebarMenuItem>
	);
}

function RemoteThreadList({
	conversations,
	disabledReason,
	node,
}: {
	conversations: readonly Conversation[];
	disabledReason: string | null;
	node: Node;
}) {
	const { folders, loose } = useMemo(
		() => groupRemoteThreads(conversations),
		[conversations]
	);
	if (folders.length === 0 && loose.length === 0) {
		return (
			<p className="type-compact px-3 py-1 text-muted-foreground">
				No threads yet.
			</p>
		);
	}
	return (
		<>
			{folders.map((folder) => (
				<div key={folder.key}>
					<div className="type-compact flex items-center gap-1.5 px-2 pt-1 text-muted-foreground">
						<HugeiconsIcon className="shrink-0" icon={Folder01Icon} size={12} />
						<span className="min-w-0 truncate" title={folder.name}>
							{folder.name}
						</span>
					</div>
					<SidebarMenu nestedIndent>
						{folder.conversations.map((conversation) => (
							<RemoteThreadRow
								conversation={conversation}
								disabledReason={disabledReason}
								key={conversation.id}
								node={node}
							/>
						))}
					</SidebarMenu>
				</div>
			))}
			{loose.length > 0 ? (
				<SidebarMenu>
					{loose.map((conversation) => (
						<RemoteThreadRow
							conversation={conversation}
							disabledReason={disabledReason}
							key={conversation.id}
							node={node}
						/>
					))}
				</SidebarMenu>
			) : null}
		</>
	);
}

function RemoteComputerGroup({
	collapsed,
	node,
	onNewChat,
	onToggle,
	overridesEnabled,
}: {
	collapsed: boolean;
	node: Node;
	onNewChat: () => void;
	onToggle: () => void;
	overridesEnabled: boolean;
}) {
	const online = useNodeOnline(node);
	const { conversations, updatedAt } = useNodeConversations(node, {
		online,
		expanded: !collapsed,
	});
	const offline = online === false;
	let disabledReason: string | null = null;
	if (!overridesEnabled) {
		disabledReason = "Turn on per-tab computers to open this thread";
	} else if (offline) {
		disabledReason = updatedAt
			? `Offline. Last seen ${compactAge(updatedAt)} ago`
			: "Offline";
	}
	let body: ReactNode;
	if (conversations) {
		body = (
			<RemoteThreadList
				conversations={conversations}
				disabledReason={disabledReason}
				node={node}
			/>
		);
	} else if (offline) {
		body = (
			<p className="type-compact px-3 py-1 text-muted-foreground">
				Offline. Threads appear when it reconnects.
			</p>
		);
	} else {
		body = (
			<p className="type-compact px-3 py-1 text-muted-foreground">
				Loading threads…
			</p>
		);
	}
	return (
		<SidebarGroup
			data-computer={node.name}
			data-testid={`computers-group-${node.name}`}
			spacing="compact"
		>
			<ComputerGroupHeader
				collapsed={collapsed}
				// The binding a remote "+" relies on is ignored while per-tab
				// computers are off, so the chat would silently run on the default.
				newChatDisabledReason={
					overridesEnabled
						? null
						: "Turn on per-tab computers to start a chat on this computer"
				}
				node={node}
				online={online}
				onNewChat={onNewChat}
				onToggle={onToggle}
			/>
			{collapsed ? null : <SidebarGroupContent>{body}</SidebarGroupContent>}
		</SidebarGroup>
	);
}

function DefaultComputerGroup({
	children,
	collapsed,
	node,
	onNewChat,
	onToggle,
}: {
	children: ReactNode;
	collapsed: boolean;
	node: Node;
	onNewChat: () => void;
	onToggle: () => void;
}) {
	const online = useNodeOnline(node);
	return (
		<div data-computer={node.name} data-testid={`computers-group-${node.name}`}>
			<div className="px-2 pt-1">
				<ComputerGroupHeader
					collapsed={collapsed}
					node={node}
					online={online}
					onNewChat={onNewChat}
					onToggle={onToggle}
				/>
			</div>
			{collapsed ? null : children}
		</div>
	);
}

export interface AllComputersSidebarProps {
	/** Start a fresh chat bound to `node`. */
	onNewChatOn: (node: Node) => void;
	/** The default computer's regular sections (Pinned, Projects, Chats, …). */
	renderLocalSections: () => ReactNode;
}

export function AllComputersSidebar({
	onNewChatOn,
	renderLocalSections,
}: AllComputersSidebarProps) {
	const nodes = useNodeStore((s) => s.nodes);
	const defaultNode = useNodeStore((s) => s.getActiveNode());
	const overridesEnabled = useNodeTabOverride();
	const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
	const toggle = useCallback((name: string) => {
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			writeCollapsed(next);
			return next;
		});
	}, []);
	const others = nodes.filter((node) => node.name !== defaultNode.name);
	return (
		<div className="flex flex-col" data-testid="all-computers-sidebar">
			<DefaultComputerGroup
				collapsed={collapsed.has(defaultNode.name)}
				node={defaultNode}
				onNewChat={() => onNewChatOn(defaultNode)}
				onToggle={() => toggle(defaultNode.name)}
			>
				{renderLocalSections()}
			</DefaultComputerGroup>
			{!overridesEnabled && others.length > 0 ? (
				<div className="type-compact mx-3 my-1 flex flex-col gap-1 rounded-md border border-border px-2 py-1.5 text-muted-foreground">
					<span>
						Threads from other computers open in a tab bound to that computer.
						Per-tab computers are turned off.
					</span>
					<Button
						className="self-start"
						onClick={() => setNodeTabOverride(true)}
						size="xs"
						variant="outline"
					>
						Turn on per-tab computers
					</Button>
				</div>
			) : null}
			{others.map((node) => (
				<RemoteComputerGroup
					collapsed={collapsed.has(node.name)}
					key={node.name}
					node={node}
					onNewChat={() => onNewChatOn(node)}
					onToggle={() => toggle(node.name)}
					overridesEnabled={overridesEnabled}
				/>
			))}
		</div>
	);
}
