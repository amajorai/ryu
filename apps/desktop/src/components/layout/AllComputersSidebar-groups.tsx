// Per-computer groups (header, remote list, default sections) for the
// "All computers" sidebar.

import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	SidebarGroup,
	SidebarGroupContent,
} from "@ryu/ui/components/sidebar.tsx";
import type { ReactNode } from "react";
import { nodeSettingsLabel } from "@/src/components/gateway/GatewayNodeScopePicker.tsx";
import { useNodeConversations } from "@/src/hooks/useNodeConversations.ts";
import { useNodeOnline } from "@/src/hooks/useNodeOnline.ts";
import { compactAge } from "@/src/lib/time.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import { RemoteThreadList } from "./AllComputersSidebar-thread-list.tsx";
import { NodeStatusDot } from "./NodeStatusDot.tsx";

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
	const tl = useLiteralMessages();
	const label = nodeSettingsLabel(node);
	const newChatDisabled = newChatDisabledReason !== null;
	return (
		<div className="group/computer flex h-8 items-center gap-1 px-1">
			<button
				aria-expanded={!collapsed}
				className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left font-medium text-sidebar-foreground text-sm outline-hidden transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
				onClick={onToggle}
				type="button"
			>
				<HugeiconsIcon
					className="shrink-0 text-muted-foreground"
					icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
					size={14}
				/>
				<NodeStatusDot online={online} />
				<span className="min-w-0 truncate">{label}</span>
				{node.managed ? (
					<span className="shrink-0 font-normal text-muted-foreground text-xs">
						Cloud
					</span>
				) : null}
			</button>
			<Button
				aria-disabled={newChatDisabled || undefined}
				aria-label={tl("New chat on {label}", { label })}
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

export function RemoteComputerGroup({
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
	const tl = useLiteralMessages();
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
			? tl("Offline. Last seen {age} ago", { age: compactAge(updatedAt) })
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
			<p className="flex min-h-8 items-center px-3 text-detail text-muted-foreground">
				Offline. Threads appear when it reconnects.
			</p>
		);
	} else {
		body = (
			<p className="flex min-h-8 items-center px-3 text-detail text-muted-foreground">
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

export function DefaultComputerGroup({
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
