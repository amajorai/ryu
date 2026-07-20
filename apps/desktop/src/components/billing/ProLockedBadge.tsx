// apps/desktop/src/components/billing/ProLockedBadge.tsx
//
// A small "Pro" badge that marks a locked Band-2 feature (free-tier gating plan,
// 2026-07-11). It is deliberately NOT a padlock: the plan's locked-UX decision is
// show-the-feature-locked-with-upsell for better discovery. Clicking the badge
// opens the dismissible PaywallModal via `requestUpgrade()` from the entitlement
// context, so a free user sees exactly what Pro unlocks instead of a hidden
// feature.
//
// Must be rendered inside an EntitlementProvider (i.e. the main app tree). The
// companion overlay window has no provider, so it gates with its own inline
// locked panel rather than this badge.

import { SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";

interface ProLockedBadgeProps {
	/** Optional extra classes for layout at the call-site. */
	className?: string;
	/** Human name of the gated feature, shown in the upgrade tooltip. */
	feature: string;
}

/** Clickable "Pro" pill marking a locked feature; opens the upgrade paywall. */
export function ProLockedBadge({ feature, className }: ProLockedBadgeProps) {
	const { requestUpgrade } = useEntitlementContext();
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						className={cn(
							"inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-3xl border border-warning/40 bg-warning/10 px-2 py-0.5 font-medium text-warning text-xs transition-colors hover:bg-warning/20",
							className
						)}
						onClick={requestUpgrade}
						type="button"
					>
						<HugeiconsIcon
							className="size-3"
							icon={SparklesIcon}
							strokeWidth={2}
						/>
						Pro
					</button>
				}
			/>
			<TooltipContent>Upgrade to Pro to use {feature}</TooltipContent>
		</Tooltip>
	);
}
