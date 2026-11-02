import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { DirectionalIcon } from "@ryu/ui/components/directional-icon.tsx";
import { cn } from "@ryu/ui/lib/utils";

/**
 * The marketing site's trailing link arrow. Landing copy never types a "→"
 * glyph: a call-to-action or a flow step renders this icon instead, sized to
 * the surrounding text (`1em`) and hidden from assistive tech, so a link's
 * accessible name stays its words. It points toward the inline end, so it
 * mirrors in right-to-left pages. Pass `className` for hover nudges; use
 * `rtl:` variants (or logical utilities) so a nudge follows the arrow.
 */
export function LinkArrow({ className }: { className?: string }) {
	return (
		<DirectionalIcon
			aria-hidden="true"
			className={cn(
				"inline-block size-[1em] shrink-0 align-[-0.125em]",
				className
			)}
			icon={ArrowRight02Icon}
		/>
	);
}
