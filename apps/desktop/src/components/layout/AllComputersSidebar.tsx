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

import { Button } from "@ryu/ui/components/button.tsx";
import { type ReactNode, useCallback, useState } from "react";
import {
	setNodeTabOverride,
	useNodeTabOverride,
} from "@/src/hooks/useNodeDisplayMode.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	readCollapsed,
	writeCollapsed,
} from "./AllComputersSidebar-collapse.ts";
import {
	DefaultComputerGroup,
	RemoteComputerGroup,
} from "./AllComputersSidebar-groups.tsx";

export { COMPUTERS_COLLAPSED_KEY } from "./AllComputersSidebar-collapse.ts";
export {
	groupRemoteThreads,
	type RemoteFolderGroup,
} from "./AllComputersSidebar-remote-threads.ts";

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
				<div className="mx-3 my-1 flex flex-col gap-1 px-2 py-1.5 text-detail text-muted-foreground">
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
