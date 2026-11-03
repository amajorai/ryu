import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * The scroll frame below md: a page-colour fade over the right edge hints that
 * the table continues sideways. Decorative and click-through; md up, where the
 * tables fit, it is gone.
 */
export const SCROLL_FADE_CLASS =
	"pointer-events-none absolute inset-y-0 -end-6 w-8 bg-linear-to-l rtl:bg-linear-to-r from-background to-transparent md:hidden";

/**
 * A wide table's frame: it scrolls sideways inside itself on narrow screens,
 * never the page, and it is a labelled, focusable region so keyboard users can
 * scroll it. The inner frame is `relative` so absolutely positioned sr-only
 * cell labels stay inside the scroll frame and never widen the page; the outer
 * one anchors the edge fade.
 */
export function ScrollRegion({
	label,
	className,
	children,
}: {
	/** The region's accessible name; usually the table's caption or title. */
	label: string;
	/** Extra classes for the scroll frame (e.g. `hidden md:block`). */
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={cn("relative", className)} data-scroll-region="">
			<div
				aria-label={label}
				className="relative -mx-6 overflow-x-auto rounded-xl px-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				role="region"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the table scrolls sideways on phones and its cells are mostly not focusable, so keyboard users focus the frame to scroll it (WCAG 2.1.1).
				tabIndex={0}
			>
				{children}
			</div>
			<div
				aria-hidden="true"
				className={SCROLL_FADE_CLASS}
				data-scroll-fade=""
			/>
		</div>
	);
}
