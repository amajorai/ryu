"use client";

import { Ticket02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";

/** Ticket mark for a listing covered by A Major Pass. */
export function MarketplaceAccessBadge({
	membershipEntitled = false,
	membershipIncluded = false,
	tone = "default",
	className,
}: {
	className?: string;
	membershipEntitled?: boolean;
	membershipIncluded?: boolean;
	tone?: "default" | "hero";
}) {
	if (!membershipIncluded) {
		return null;
	}

	const title = membershipEntitled ? "Included with your plan" : "A Major Pass";
	const description = membershipEntitled
		? "This supported paid app is included with your current subscription plan."
		: "Get this with A Major Pass or a qualifying subscription plan.";
	const triggerLabel = membershipEntitled
		? "Included with your plan"
		: "Get this with A Major Pass or a qualifying subscription plan";

	return (
		<Popover modal={false}>
			<PopoverTrigger
				aria-label={triggerLabel}
				className={cn(
					"pointer-events-auto relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-primary outline-none transition-colors hover:text-primary/75 focus-visible:ring-2 focus-visible:ring-ring",
					tone === "hero" && "text-white hover:text-white/75",
					className
				)}
				data-slot="marketplace-access-trigger"
				render={
					<button aria-label={triggerLabel} type="button">
						<HugeiconsIcon
							aria-hidden="true"
							className="size-4"
							icon={Ticket02Icon}
						/>
					</button>
				}
			/>
			<PopoverContent
				align="start"
				className="w-[min(20rem,calc(100vw-2rem))] gap-3"
				data-slot="marketplace-access-popover"
				side="bottom"
			>
				<PopoverHeader>
					<PopoverTitle className="flex items-center gap-2">
						<HugeiconsIcon
							aria-hidden="true"
							className="size-4 text-primary"
							icon={Ticket02Icon}
						/>
						{title}
					</PopoverTitle>
					<PopoverDescription>{description}</PopoverDescription>
				</PopoverHeader>
			</PopoverContent>
		</Popover>
	);
}
