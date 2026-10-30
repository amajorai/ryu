import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { PinnedSummaryToggleButton } from "../PinnedSummaryToggleButton.tsx";
import { EditorButtonGroup } from "./editor-buttons.tsx";
import {
	BottomPanelIconClosed,
	BottomPanelIconOpen,
	RightPanelIconClosed,
	RightPanelIconOpen,
} from "./panel-icons.tsx";

// ── Panel toggle buttons ──────────────────────────────────────────────────────

export interface PanelToggleButtonsProps {
	bottomOpen: boolean;
	folder?: string | null;
	onBottomToggle: () => void;
	onPinnedSummaryToggle?: () => void;
	onRightToggle: () => void;
	/** Pinned summary toggle — omitted (no button) when the pair isn't provided. */
	pinnedSummaryOpen?: boolean;
	rightOpen: boolean;
	/** Whether the chat header should expose the bottom-panel button. */
	showBottomPanelToggle?: boolean;
}

export function PanelToggleButtons({
	bottomOpen,
	onBottomToggle,
	rightOpen,
	onRightToggle,
	folder,
	pinnedSummaryOpen,
	onPinnedSummaryToggle,
	showBottomPanelToggle = true,
}: PanelToggleButtonsProps) {
	const tl = useLiteralMessages();
	return (
		<>
			{/* No rule between the "Open in <editor>" group and the panel toggles —
			    the actions bar already reads as one cluster from its own rounded
			    background, and the divider only cut it in half. */}
			{folder ? <EditorButtonGroup folder={folder} /> : null}
			{onPinnedSummaryToggle ? (
				<PinnedSummaryToggleButton
					onToggle={onPinnedSummaryToggle}
					open={pinnedSummaryOpen ?? false}
				/>
			) : null}
			{showBottomPanelToggle ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label={
									bottomOpen ? "Hide bottom panel" : "Show bottom panel"
								}
								aria-pressed={bottomOpen}
								className="shrink-0 aria-pressed:text-foreground"
								onClick={onBottomToggle}
								size="icon-sm"
								variant="ghost-muted"
							>
								{bottomOpen ? (
									<BottomPanelIconOpen className="size-4" />
								) : (
									<BottomPanelIconClosed className="size-4" />
								)}
							</Button>
						}
					/>
					<TooltipContent>
						{bottomOpen ? tl("Hide bottom panel") : tl("Show bottom panel")}
					</TooltipContent>
				</Tooltip>
			) : null}
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							aria-label={rightOpen ? "Hide right panel" : "Show right panel"}
							aria-pressed={rightOpen}
							className="shrink-0 aria-pressed:text-foreground"
							onClick={onRightToggle}
							size="icon-sm"
							variant="ghost-muted"
						>
							{rightOpen ? (
								<RightPanelIconOpen className="size-4" />
							) : (
								<RightPanelIconClosed className="size-4" />
							)}
						</Button>
					}
				/>
				<TooltipContent>
					{rightOpen ? tl("Hide right panel") : tl("Show right panel")}
				</TooltipContent>
			</Tooltip>
		</>
	);
}
