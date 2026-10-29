// apps/desktop/src/components/chat/ComputerChip.tsx
//
// The composer's computer chip: which computer a NEW chat runs on. It sits in
// the workspace strip, before the project chip, and mirrors the node settings
// dialog's computer picker (same labels, an online dot per computer).
//
// A chat belongs to the computer it started on (its history lives in that
// computer's Core), so the chip is only editable on an empty draft. Once the
// chat has a message it renders as a static chip that says so. With a single
// configured computer there is nothing to choose and it renders nothing. With
// per-tab computers turned off a tab's binding is ignored (every chat runs on
// the default computer), so the chip renders nothing rather than claim a pick
// that would not be honoured.

import { LaptopIcon, Link01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import {
	WORKSPACE_MENU_CONTENT,
	WORKSPACE_SELECT_TRIGGER,
} from "@/components/agent-elements/input/composer-select.ts";
import { nodeSettingsLabel } from "@/src/components/gateway/GatewayNodeScopePicker.tsx";
import { NodeStatusDot } from "@/src/components/layout/NodeStatusDot.tsx";
import { useOptionalChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useNodeTabOverride } from "@/src/hooks/useNodeDisplayMode.ts";
import { useNodeOnline } from "@/src/hooks/useNodeOnline.ts";
import {
	isLocalNode,
	type Node,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";

export const COMPUTER_CHIP_LOCKED_HINT =
	"Start a new chat to use another computer";

export interface ComputerChipProps {
	/** Locked once the chat has messages: it stays on its computer. */
	locked?: boolean;
	onChange: (name: string) => void;
	/** The chosen computer's name; `null` = the default computer. */
	value: string | null;
}

function ComputerOption({
	node,
	selected,
	onSelect,
}: {
	node: Node;
	selected: boolean;
	onSelect: () => void;
}) {
	const online = useNodeOnline(node);
	return (
		<DropdownMenuItem onClick={onSelect}>
			<NodeStatusDot className="mr-2" online={online} />
			<span className="min-w-0 flex-1 truncate">
				{nodeSettingsLabel(node)}
				{node.managed ? " · cloud" : ""}
			</span>
			{selected ? (
				<HugeiconsIcon className="ml-2" icon={Tick02Icon} size={12} />
			) : null}
		</DropdownMenuItem>
	);
}

export function ComputerChip({ locked, onChange, value }: ComputerChipProps) {
	const nodes = useNodeStore((s) => s.nodes);
	const defaultNode = useNodeStore((s) => s.getActiveNode());
	const selected =
		(value ? nodes.find((node) => node.name === value) : undefined) ??
		defaultNode;
	const online = useNodeOnline(selected);
	const overridesEnabled = useNodeTabOverride();
	const tl = useLiteralMessages();
	if (nodes.length < 2 || !overridesEnabled) {
		return null;
	}
	const label = nodeSettingsLabel(selected);
	const icon = isLocalNode(selected) ? LaptopIcon : Link01Icon;
	if (locked) {
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<span
							aria-label={tl(
								"Runs on {label}. Start a new chat to use another computer",
								{ label }
							)}
							className={`${WORKSPACE_SELECT_TRIGGER} inline-flex items-center text-muted-foreground`}
							data-locked="true"
							data-testid="composer-computer-chip"
						/>
					}
				>
					<HugeiconsIcon className="size-3.5 shrink-0" icon={icon} />
					<span className="max-w-28 truncate">{label}</span>
				</TooltipTrigger>
				<TooltipContent>{COMPUTER_CHIP_LOCKED_HINT}</TooltipContent>
			</Tooltip>
		);
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={tl("Runs on {label}. Choose a computer", { label })}
						className={WORKSPACE_SELECT_TRIGGER}
						data-testid="composer-computer-chip"
						size="sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				<HugeiconsIcon className="size-3.5 shrink-0" icon={icon} />
				<NodeStatusDot online={online} />
				<ButtonLabel className="max-w-28">{label}</ButtonLabel>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className={WORKSPACE_MENU_CONTENT}
				side="top"
				sideOffset={6}
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>Run this chat on</DropdownMenuLabel>
					{nodes.map((node) => (
						<ComputerOption
							key={node.name}
							node={node}
							onSelect={() => onChange(node.name)}
							selected={node.name === selected.name}
						/>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The tab's computer, read from and written to its per-tab node override. */
export function TabComputerChip({
	conversationId,
	tabId,
}: {
	conversationId?: string | null;
	tabId: string;
}) {
	const override = useNodeStore((s) => s.tabOverrides[tabId]);
	const tabConversationId = useTabSelector(
		(state) => state.tabs.find((tab) => tab.id === tabId)?.conversationId
	);
	const history = useOptionalChatHistoryContext();
	const messageCount = conversationId
		? (history?.conversations.find((c) => c.id === conversationId)
				?.messageCount ?? 0)
		: 0;
	// A tab learns its conversation id on the first send, so a bound id means
	// the chat has started; the message count covers an opened existing thread.
	const locked = Boolean(tabConversationId) || messageCount > 0;
	return (
		<ComputerChip
			locked={locked}
			onChange={(name) => {
				const store = useNodeStore.getState();
				if (name === store.getActiveNode().name) {
					store.clearTabOverride(tabId);
				} else {
					store.setTabOverride(tabId, name);
				}
			}}
			value={override ?? null}
		/>
	);
}
