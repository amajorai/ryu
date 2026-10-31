import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";

/**
 * The marketing site's trailing link arrow. Landing copy never types a "→"
 * glyph: a call-to-action or a flow step renders this icon instead, sized to
 * the surrounding text (`1em`) and hidden from assistive tech, so a link's
 * accessible name stays its words. Pass `className` for hover nudges.
 */
export function LinkArrow({ className }: { className?: string }) {
	return (
		<HugeiconsIcon
			aria-hidden="true"
			className={cn(
				"inline-block size-[1em] shrink-0 align-[-0.125em]",
				className
			)}
			icon={ArrowRight02Icon}
		/>
	);
}
