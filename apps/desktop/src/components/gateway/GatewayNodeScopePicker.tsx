// apps/desktop/src/components/gateway/GatewayNodeScopePicker.tsx
//
// "Settings for <computer> ▾" header of the node settings dialog. Every section
// in that dialog configures the dialog's chosen computer, so this picker is the
// in-place way to say which computer is being configured without closing the
// dialog and going back to the sidebar's computer selector.
//
// Picking a computer here scopes only the dialog: the dialog provides the choice
// through `NodeScopeProvider`, and every section resolves its node through
// `useActiveNode()` and friends, so reads and writes go to the chosen computer
// while chats keep using the app-wide one. "Use for chats too" is the explicit
// way to also make it the app-wide computer, as the sidebar selector does.

import {
	ArrowDown01Icon,
	LaptopIcon,
	Link01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	isLocalNode,
	type Node,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";

/** The label the computer selector shows for a node. */
export function nodeSettingsLabel(node: Pick<Node, "name" | "url">): string {
	if (isLocalNode(node)) {
		return "This computer";
	}
	return node.name.charAt(0).toUpperCase() + node.name.slice(1);
}

export function GatewayNodeScopePicker({
	onScopeChange,
}: {
	onScopeChange: (name: string) => void;
	/** The dialog's chosen computer, or undefined while it follows the app. */
	scope?: string;
}) {
	// Scoped by the dialog's NodeScopeProvider: the computer being configured.
	const activeNode = useActiveNode();
	// The app-wide computer chats use (the dialog sits outside any tab).
	const chatNode = useNodeStore((s) => s.getActiveNode());
	const nodes = useNodeStore((s) => s.nodes);
	const autoSelect = useNodeStore((s) => s.autoSelect);
	const setAutoSelect = useNodeStore((s) => s.setAutoSelect);
	const setDefault = useNodeStore((s) => s.setDefault);
	const tl = useLiteralMessages();

	const selectNode = (name: string) => {
		if (name === activeNode.name) {
			return;
		}
		onScopeChange(name);
	};

	const selectForChats = () => {
		// Auto-select would immediately pick its own computer again; an explicit
		// choice here is the user turning it off, as in the sidebar selector.
		if (autoSelect) {
			setAutoSelect(false);
		}
		void setDefault(activeNode.name);
	};

	return (
		<div className="pb-1">
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={tl("Settings for {computerName}. Choose a computer", {
						computerName: nodeSettingsLabel(activeNode),
					})}
					className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm outline-none transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0 focus-visible:ring-2 focus-visible:ring-ring"
				>
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={isLocalNode(activeNode) ? LaptopIcon : Link01Icon}
					/>
					<span className="min-w-0 flex-1 truncate">
						{nodeSettingsLabel(activeNode)}
					</span>
					<HugeiconsIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={ArrowDown01Icon}
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuLabel>Configure computer</DropdownMenuLabel>
					{nodes.map((node) => (
						<DropdownMenuItem
							key={node.name}
							onClick={() => selectNode(node.name)}
						>
							<HugeiconsIcon
								className="size-4 text-muted-foreground"
								icon={isLocalNode(node) ? LaptopIcon : Link01Icon}
							/>
							<span className="min-w-0 flex-1 truncate">
								{nodeSettingsLabel(node)}
								{node.managed ? " · cloud" : ""}
							</span>
							{node.name === activeNode.name ? (
								<HugeiconsIcon className="size-4" icon={Tick02Icon} />
							) : null}
						</DropdownMenuItem>
					))}
					{activeNode.name === chatNode.name ? null : (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={selectForChats}>
								Use for chats too
							</DropdownMenuItem>
						</>
					)}
					{/* Only worth saying when the dialog and chats point at different
					    computers. */}
					{activeNode.name === chatNode.name ? null : (
						<p className="max-w-60 px-2 py-1.5 text-muted-foreground text-xs">
							{tl(
								"Changes here apply only to {computerName}. Chats keep using {chatComputerName}.",
								{
									computerName: nodeSettingsLabel(activeNode),
									chatComputerName: nodeSettingsLabel(chatNode),
								}
							)}
						</p>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
