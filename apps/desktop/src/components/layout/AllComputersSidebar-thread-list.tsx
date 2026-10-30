// Read-only rows for another computer's threads in the "All computers" sidebar.

import {
	Folder01Icon,
	LaptopIcon,
	LinkSquare02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { cn } from "@/lib/utils.ts";
import { ContinuedOnBadge } from "@/src/components/chat/ContinuedOnBanner.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { nodeConversationsQueryKey } from "@/src/hooks/useNodeConversations.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	clearRnpContinued,
	workspaceErrorMessage,
} from "@/src/lib/api/continuity-workspace.ts";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import { compactAge } from "@/src/lib/time.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { groupRemoteThreads } from "./AllComputersSidebar-remote-threads.ts";
import { OpenInNewWindowContextMenuItem } from "./OpenInNewWindowMenuItem.tsx";

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
				"flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring",
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
			<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
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
						<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
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
							<HugeiconsIcon className="size-4" icon={LaptopIcon} />
							Take back here
						</ContextMenuItem>
					) : null}
				</ContextMenuContent>
			</ContextMenu>
		</SidebarMenuItem>
	);
}

export function RemoteThreadList({
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
			<p className="flex min-h-8 items-center px-3 text-detail text-muted-foreground">
				No threads yet.
			</p>
		);
	}
	return (
		<>
			{folders.map((folder) => (
				<div key={folder.key}>
					<div className="flex h-7 items-center gap-1.5 px-2 text-detail text-muted-foreground">
						<HugeiconsIcon className="size-3.5 shrink-0" icon={Folder01Icon} />
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
