import { LayoutListIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { notePinnedSummaryToggle } from "./pinned-summary/pinned-summary-open-request.ts";

export function PinnedSummaryToggleButton({
	open,
	onToggle,
}: {
	onToggle: () => void;
	open: boolean;
}) {
	const tl = useLiteralMessages();
	const label = open ? tl("Hide pinned summary") : tl("Show pinned summary");
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={label}
						aria-pressed={open}
						className="shrink-0 aria-pressed:text-foreground"
						onClick={() => {
							notePinnedSummaryToggle(open);
							onToggle();
						}}
						size="icon-sm"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={LayoutListIcon} />
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
