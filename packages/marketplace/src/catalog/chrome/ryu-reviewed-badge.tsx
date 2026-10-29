import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";

/** A platform-admin review of this listing's code, separate from publisher trust. */
export function RyuReviewedBadge({
	reviewed = false,
	tone = "card",
}: {
	reviewed?: boolean;
	tone?: "card" | "hero";
}) {
	if (!reviewed) {
		return null;
	}
	return (
		<Badge
			appearance={tone === "hero" ? "ryu-reviewed-hero" : "ryu-reviewed-card"}
			data-testid="ryu-reviewed-badge"
			variant="outline"
		>
			<HugeiconsIcon className="size-3" icon={CheckmarkCircle02Icon} />
			Verified by Ryu
		</Badge>
	);
}
