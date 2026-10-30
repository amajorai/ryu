import { UserMultiple02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type ResourceVisibility,
	resourceVisibilityGroup,
	resourceVisibilityLabel,
} from "@/src/lib/resource-visibility.ts";

export function ResourceVisibilityIndicator({
	className,
	system,
	visibility,
}: {
	className?: string;
	system?: boolean;
	visibility?: ResourceVisibility;
}) {
	const group = resourceVisibilityGroup(visibility ?? "private", system);
	// Private is the default, so it carries no glyph; only a shared resource
	// is marked.
	if (group === "private") {
		return null;
	}
	const label = resourceVisibilityLabel(visibility ?? "private", system);
	return (
		<span
			aria-label={label}
			className={`inline-flex shrink-0 items-center justify-center text-muted-foreground/70 ${className ?? ""}`}
			title={label}
		>
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3.5"
				icon={UserMultiple02Icon}
			/>
		</span>
	);
}
