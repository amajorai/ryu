import { LayoutListIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";

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
					<button
						aria-label={label}
						aria-pressed={open}
						className={cn(
							"flex size-8 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-muted hover:text-foreground",
							open ? "text-foreground" : "text-muted-foreground"
						)}
						onClick={onToggle}
						type="button"
					>
						<HugeiconsIcon className="size-4" icon={LayoutListIcon} />
					</button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
