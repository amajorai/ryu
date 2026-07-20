// apps/desktop/src/components/layout/GooeyMenu.tsx
//
// A "gooey" expanding action menu (Skiper-style): a small trigger button that,
// when opened, springs a vertical stack of action blobs upward out of itself.
// The liquid/merge look comes from an SVG goo filter (blur + a high-contrast
// color-matrix) applied to a layer of solid blobs sitting *behind* a crisp,
// unfiltered layer of icon buttons. Both layers are driven by the same spring
// targets so the blobs and icons move as one — the filter only ever touches the
// colored blobs, never the icons (which would otherwise blur).
//
// Used in the sidebar footer for the "+" create menu. Honors
// prefers-reduced-motion by snapping items in/out with no spring.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import {
	AnimatePresence,
	motion,
	type Transition,
	useReducedMotion,
} from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";

export interface GooeyAction {
	icon: IconSvgElement;
	id: string;
	label: string;
	onSelect: () => void;
}

// Footer icon buttons are 28px (h-7 w-7); match that so the trigger blob lines
// up exactly under the trigger button. STEP is the centre-to-centre distance
// between stacked blobs — kept just above the blob size so adjacent blobs stay
// close enough for the goo to bridge them mid-flight (the "drip").
const BLOB_PX = 28;
const STEP_PX = 38;

export function GooeyMenu({
	actions,
	label = "Create",
}: {
	actions: GooeyAction[];
	label?: string;
}) {
	const reduce = useReducedMotion();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	// useId() yields colon-bearing ids (":r0:") that are invalid inside a CSS
	// `url(#…)` fragment, so the goo filter would silently never apply — strip
	// them to a plain token.
	const filterId = `gooey-${useId().replace(/:/g, "")}`;

	// Close on outside pointerdown or Escape — the menu has no backdrop of its own.
	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (e: PointerEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setOpen(false);
			}
		};
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const spring = (index: number): Transition =>
		reduce
			? { duration: 0 }
			: {
					type: "spring",
					stiffness: 520,
					damping: 30,
					delay: index * 0.035,
				};

	const targetY = (index: number) => -(index + 1) * STEP_PX;

	return (
		<div className="relative size-7 shrink-0" ref={rootRef}>
			{/* Goo blob layer: solid circles only, filtered, non-interactive, behind.
			    A CSS `filter` clips its subtree to the filter region (relative to this
			    element's box), so the box is sized tall enough to hold the fully
			    expanded stack — otherwise the upward blobs would be cut off. */}
			<div
				aria-hidden
				className="pointer-events-none absolute bottom-0 left-0"
				style={{
					width: BLOB_PX,
					height: STEP_PX * actions.length + BLOB_PX,
					filter: `url(#${filterId})`,
				}}
			>
				{/* The trigger blob anchors the goo so the first item drips out of it. */}
				<span className="absolute bottom-0 left-0 size-7 rounded-full bg-muted" />
				<AnimatePresence>
					{open &&
						actions.map((action, i) => (
							<motion.span
								animate={{ y: targetY(i), scale: 1, opacity: 1 }}
								className="absolute bottom-0 left-0 size-7 rounded-full bg-muted"
								exit={{ y: 0, scale: 0.3, opacity: 0 }}
								initial={{ y: 0, scale: 0.3, opacity: 0 }}
								key={action.id}
								style={{ width: BLOB_PX, height: BLOB_PX }}
								transition={spring(i)}
							/>
						))}
				</AnimatePresence>
			</div>

			{/* Crisp interactive layer: icons + buttons, unfiltered, on top. */}
			<div className="absolute inset-0">
				<AnimatePresence>
					{open &&
						actions.map((action, i) => (
							<motion.div
								animate={{ y: targetY(i), scale: 1, opacity: 1 }}
								className="absolute bottom-0 left-0"
								exit={{ y: 0, scale: 0.3, opacity: 0 }}
								initial={{ y: 0, scale: 0.3, opacity: 0 }}
								key={action.id}
								transition={spring(i)}
							>
								<Tooltip>
									<TooltipTrigger
										render={
											<button
												aria-label={action.label}
												className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
												onClick={() => {
													action.onSelect();
													setOpen(false);
												}}
												type="button"
											>
												<HugeiconsIcon icon={action.icon} size={14} />
											</button>
										}
									/>
									<TooltipContent side="right">{action.label}</TooltipContent>
								</Tooltip>
							</motion.div>
						))}
				</AnimatePresence>

				{/* Trigger: the "+" rotates into an "×" while the menu is open. */}
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								aria-expanded={open}
								aria-label={label}
								className="relative flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
								onClick={() => setOpen((prev) => !prev)}
								type="button"
							>
								<motion.span
									animate={{ rotate: open ? 135 : 0 }}
									className="flex"
									transition={reduce ? { duration: 0 } : { duration: 0.2 }}
								>
									<HugeiconsIcon icon={Add01Icon} size={16} />
								</motion.span>
							</button>
						}
					/>
					<TooltipContent>{label}</TooltipContent>
				</Tooltip>
			</div>

			{/* Goo filter. A generous region keeps the upward-expanding blobs from
			    being clipped to the trigger's box. The color-matrix sharpens the
			    blurred alpha so overlapping blobs fuse into a single liquid shape. */}
			<svg aria-hidden className="absolute size-0" focusable="false">
				<title>Gooey menu filter</title>
				<defs>
					<filter height="300%" id={filterId} width="300%" x="-100%" y="-100%">
						<feGaussianBlur in="SourceGraphic" result="blur" stdDeviation="5" />
						<feColorMatrix
							in="blur"
							mode="matrix"
							result="goo"
							values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10"
						/>
						<feComposite in="SourceGraphic" in2="goo" operator="atop" />
					</filter>
				</defs>
			</svg>
		</div>
	);
}
