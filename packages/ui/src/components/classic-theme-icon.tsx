import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils.ts";

interface ClassicThemeIconProps {
	className?: string;
}

/**
 * Theme glyph that follows the active theme: the outline sun in light mode and
 * the outline moon in dark mode, matching the Hugeicons set used elsewhere.
 */
export function ClassicThemeIcon({
	className = "size-4",
}: ClassicThemeIconProps) {
	return (
		<span
			aria-hidden="true"
			className={cn("relative inline-grid place-items-center", className)}
		>
			<HugeiconsIcon
				className="col-start-1 row-start-1 size-full transition-[opacity,scale] duration-300 motion-reduce:transition-none dark:scale-0 dark:opacity-0"
				icon={Sun03Icon}
			/>
			<HugeiconsIcon
				className="col-start-1 row-start-1 size-full scale-0 opacity-0 transition-[opacity,scale] duration-300 motion-reduce:transition-none dark:scale-100 dark:opacity-100"
				icon={Moon02Icon}
			/>
		</span>
	);
}
