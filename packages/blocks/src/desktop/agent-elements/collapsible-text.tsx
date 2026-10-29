import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type { BezierDefinition } from "motion/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	type CSSProperties,
	type MouseEvent,
	memo,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import styles from "./elements-one.module.css";

interface CollapsibleContentStyle extends CSSProperties {
	"--collapsible-full-height"?: string;
}

/**
 * The app-wide morph curve (ease-out quint): opens fast, settles softly. The CSS
 * form drives the `max-height` tween; the tuple form drives the motion fades.
 * The private content CSS owns the identical curve for the height tween;
 * this tuple is the equivalent producer for the motion fades.
 */
const MORPH_CURVE_MOTION = [0.22, 1, 0.36, 1] satisfies BezierDefinition;

export interface CollapsibleTextProps {
	children: ReactNode;
	className?: string;
	/** Applied while collapsed, e.g. `max-h-10` or `max-h-[120px]`. */
	collapsedMaxHeightClass: string;
	collapseLabel?: string;
	contentClassName?: string;
	/**
	 * A cheap scalar that changes when `children`'s TEXT changes. `children` is a
	 * fresh element every render, so it cannot be an effect dependency without
	 * tearing down the ResizeObserver on every parent render; and the observer
	 * alone misses a content swap that keeps the box at its capped height (a
	 * 6-line message replaced by a 1-line one). Pass the text, or its length.
	 */
	contentKey?: string | number;
	expandLabel?: string;
	/**
	 * Height of the bottom fade + "Show more" strip, e.g. `h-12` (the default) or
	 * `h-10`. The gradient reaches full opacity at HALF this height, so the last
	 * fully legible pixel sits at `collapsedHeight - fadeHeight / 2`: size the two
	 * together if a specific number of lines must stay clear.
	 */
	fadeHeightClass?: string;
	/** Tailwind gradient stop class matching the surface behind the fade. */
	fadeToClass?: string;
	/** Fires when the content area is clicked (not the expand control). */
	onContentClick?: () => void;
}

export const CollapsibleText = memo(function CollapsibleText({
	children,
	className,
	contentClassName,
	contentKey,
	collapsedMaxHeightClass,
	fadeHeightClass = "h-12",
	fadeToClass = "to-muted",
	expandLabel = "Show more",
	collapseLabel = "Show less",
	onContentClick,
}: CollapsibleTextProps) {
	const [expanded, setExpanded] = useState(false);
	const [canCollapse, setCanCollapse] = useState(false);
	const [fullHeight, setFullHeight] = useState(0);
	const contentRef = useRef<HTMLDivElement>(null);
	const reduceMotion = useReducedMotion();

	useEffect(() => {
		const el = contentRef.current;
		if (!el) {
			return;
		}

		const measure = () => {
			// `scrollHeight` reports the full content height even while the box is
			// capped by `max-height`, so it is measurable in BOTH states and drives
			// the expansion target. `canCollapse` compares against the capped
			// `clientHeight`, which only differs from `scrollHeight` while collapsed.
			setFullHeight(el.scrollHeight);
			if (expanded) {
				return;
			}
			setCanCollapse(el.scrollHeight > el.clientHeight + 1);
		};

		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		// While expanded the box is pinned to the measured full height, so a viewport
		// reflow (text re-wrapping) would otherwise clip the tail; remeasure on
		// resize so the pinned height tracks the content.
		window.addEventListener("resize", measure);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", measure);
		};
		// `children` is deliberately NOT a dependency: it is a fresh element on
		// every render of the parent, so depending on it destroys and rebuilds this
		// ResizeObserver on every render of the message list. The observer already
		// catches content that grows; `contentKey` covers a swap that does not
		// change the (capped) box height.
	}, [contentKey, expanded, collapsedMaxHeightClass]);

	const handleContentClick = (event: MouseEvent<HTMLDivElement>) => {
		if (!onContentClick) {
			return;
		}
		// SAFETY: native clicks in this rendered div target Elements. Only
		// Element.closest ancestry is read; no HTML-only property is assumed.
		if ((event.target as Element).closest("[data-collapsible-expand]")) {
			return;
		}
		onContentClick();
	};

	const showControls = canCollapse || expanded;
	// Expanding swaps the cap class for the measured full height, and the browser
	// tweens `max-height` between the two — no manual height bookkeeping.
	const showFullHeight = expanded && fullHeight > 0;

	const controlTransition = reduceMotion
		? { duration: 0 }
		: { duration: 0.18, ease: MORPH_CURVE_MOTION };

	return (
		<div className={cn("relative", className)}>
			<div
				className={cn(
					contentClassName,
					"overflow-hidden",
					// The height morph. While collapsed the box is held at the cap
					// class; expanding swaps it for the measured full height. The fade
					// strip and "Show less" control sit below/over the box's bottom
					// edge, so the whole disclosure opens and closes as one surface.
					styles.collapse,
					"duration-300 motion-reduce:transition-none",
					!expanded && collapsedMaxHeightClass,
					showFullHeight && "max-h-[var(--collapsible-full-height)]",
					onContentClick && "cursor-pointer"
				)}
				onClick={onContentClick ? handleContentClick : undefined}
				onKeyDown={
					onContentClick
						? (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onContentClick();
								}
							}
						: undefined
				}
				ref={contentRef}
				role={onContentClick ? "button" : undefined}
				style={
					{
						"--collapsible-full-height": showFullHeight
							? `${fullHeight}px`
							: undefined,
					} satisfies CollapsibleContentStyle as CollapsibleContentStyle
				}
				tabIndex={onContentClick ? 0 : undefined}
			>
				{children}
			</div>
			{showControls ? (
				<AnimatePresence initial={false}>
					{expanded ? (
						<motion.div
							animate={{ opacity: 1, y: 0 }}
							className="mt-1 flex justify-center"
							exit={{ opacity: 0, y: -4 }}
							initial={{ opacity: 0, y: -4 }}
							key="collapse"
							transition={controlTransition}
						>
							<Button
								appearance="collapse-toggle"
								data-collapsible-expand
								onClick={() => setExpanded(false)}
								size="sm"
								type="button"
								variant="ghost-muted"
							>
								{collapseLabel}
							</Button>
						</motion.div>
					) : (
						<motion.div
							animate={{ opacity: 1 }}
							className={cn(
								"pointer-events-none absolute inset-x-0 bottom-0",
								fadeHeightClass
							)}
							exit={{ opacity: 0 }}
							initial={{ opacity: 0 }}
							key="expand"
							transition={controlTransition}
						>
							<div
								className={cn(
									"absolute inset-0 bg-linear-to-b from-transparent to-50%",
									fadeToClass
								)}
							/>
							<div className="pointer-events-auto relative flex h-full items-end justify-center pb-0.5">
								<Button
									appearance="collapse-toggle"
									data-collapsible-expand
									onClick={(event) => {
										event.stopPropagation();
										setExpanded(true);
									}}
									size="sm"
									type="button"
									variant="ghost-muted"
								>
									{expandLabel}
								</Button>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			) : null}
		</div>
	);
});
