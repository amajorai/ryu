import {
	Activity01Icon,
	ClipboardIcon,
	LayoutBottomIcon,
	MoreHorizontalIcon,
	PinIcon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { notePinnedSummaryToggle } from "@/src/components/panels/pinned-summary/pinned-summary-open-request.ts";

export interface ChatTitlebarOverflowProps {
	/** Tools the thread's agent can call; listed in a submenu when non-empty. */
	agentTools: readonly string[];
	bottomPanelOpen: boolean;
	/** Copy the whole transcript. Omitted on an empty chat. */
	onCopyTranscript?: () => void;
	/** Open the selected agent's activity in the right dock. */
	onOpenAgentActivity?: () => void;
	/** Toggle the bottom panel. Omitted when the chat hides that panel. */
	onToggleBottomPanel?: () => void;
	/** Toggle the pinned summary. Omitted on an empty chat. */
	onTogglePinnedSummary?: () => void;
	pinnedSummaryOpen: boolean;
}

/**
 * The conversation header's `⋯` menu. The header keeps Share and the right
 * panel toggle visible; everything else a chat can do from its title bar lives
 * here, so the bar holds at most three quiet icon buttons.
 */
export function ChatTitlebarOverflow({
	agentTools,
	bottomPanelOpen,
	onCopyTranscript,
	onOpenAgentActivity,
	onToggleBottomPanel,
	onTogglePinnedSummary,
	pinnedSummaryOpen,
}: ChatTitlebarOverflowProps) {
	const hasViewItems = Boolean(onToggleBottomPanel || onTogglePinnedSummary);
	const hasThreadItems = Boolean(
		onCopyTranscript || onOpenAgentActivity || agentTools.length > 0
	);
	if (!(hasViewItems || hasThreadItems)) {
		return null;
	}
	const toolCount = formatCount(agentTools.length) ?? String(agentTools.length);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label="More chat actions"
						size="icon-sm"
						title="More"
						type="button"
						variant="ghost-muted"
					/>
				}
			>
				<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56" sideOffset={6}>
				{hasThreadItems ? (
					<DropdownMenuGroup>
						{onCopyTranscript ? (
							<DropdownMenuItem onClick={onCopyTranscript}>
								<HugeiconsIcon className="size-4" icon={ClipboardIcon} />
								Copy transcript
							</DropdownMenuItem>
						) : null}
						{onOpenAgentActivity ? (
							<DropdownMenuItem onClick={onOpenAgentActivity}>
								<HugeiconsIcon className="size-4" icon={Activity01Icon} />
								Agent activity
							</DropdownMenuItem>
						) : null}
						{agentTools.length > 0 ? (
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>
									<HugeiconsIcon className="size-4" icon={Wrench01Icon} />
									{`${toolCount} ${agentTools.length === 1 ? "tool" : "tools"}`}
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
									{agentTools.map((tool) => (
										<DropdownMenuItem disabled key={tool}>
											<span className="truncate">{tool}</span>
										</DropdownMenuItem>
									))}
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						) : null}
					</DropdownMenuGroup>
				) : null}
				{hasThreadItems && hasViewItems ? <DropdownMenuSeparator /> : null}
				{hasViewItems ? (
					<DropdownMenuGroup>
						{onTogglePinnedSummary ? (
							<DropdownMenuItem
								onClick={() => {
									notePinnedSummaryToggle(pinnedSummaryOpen);
									onTogglePinnedSummary();
								}}
							>
								<HugeiconsIcon className="size-4" icon={PinIcon} />
								{pinnedSummaryOpen
									? "Hide pinned summary"
									: "Show pinned summary"}
							</DropdownMenuItem>
						) : null}
						{onToggleBottomPanel ? (
							<DropdownMenuItem onClick={onToggleBottomPanel}>
								<HugeiconsIcon className="size-4" icon={LayoutBottomIcon} />
								{bottomPanelOpen ? "Hide bottom panel" : "Show bottom panel"}
							</DropdownMenuItem>
						) : null}
					</DropdownMenuGroup>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
