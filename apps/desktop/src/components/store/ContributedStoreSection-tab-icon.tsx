import { Package01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Icon } from "@ryu/ui/components/icon.tsx";

/** Fallback glyph when neither the tab nor the row declares one. */
const FALLBACK_ICON = Package01Icon;

export function TabIcon({
	icon,
	className,
}: {
	className?: string;
	icon?: string;
}) {
	if (icon) {
		return <Icon className={className} icon={icon} size={20} />;
	}
	return <HugeiconsIcon className={className} icon={FALLBACK_ICON} />;
}
