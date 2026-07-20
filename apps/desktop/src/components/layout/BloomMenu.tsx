// Adapted from beui.dev/components/blocks/bloom-menu — a "Create" button that
// morphs open into a grid of options and blooms iris-out from the center, the
// grid revealing in every direction with a radially staggered stagger. Swapped
// onto this repo's stack: framer-motion (not motion/react), @ryu/ui's `cn`, an
// inlined EASE_OUT token, and per-item `onSelect` so each cell can route to a
// different destination.

import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Plus, X } from "lucide-react";
import { type ComponentType, useEffect, useId, useRef, useState } from "react";

// cubic-bezier(0.16, 1, 0.3, 1) — strong ease-out; defaults feel weak here.
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export interface BloomMenuItem {
	icon: ComponentType<{ className?: string }>;
	label: string;
	onSelect: () => void;
}

// Folder-open feel: a touch of overshoot as the panel expands, kept subtle.
const SPRING_FOLDER = {
	type: "spring",
	stiffness: 300,
	damping: 32,
	mass: 0.9,
} as const;

const GRID_COLS = 3;

export interface BloomMenuProps {
	className?: string;
	items: BloomMenuItem[];
	title?: string;
	triggerLabel?: string;
}

export function BloomMenu({
	items,
	title = "Create",
	triggerLabel = "Create",
	className,
}: BloomMenuProps) {
	const [open, setOpen] = useState(false);
	const reduce = useReducedMotion();
	const layoutId = useId();
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setOpen(false);
			}
		};
		const onPointer = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", onPointer);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onPointer);
		};
	}, [open]);

	const morph = reduce ? { duration: 0.15 } : SPRING_FOLDER;
	const rows = Math.ceil(items.length / GRID_COLS);

	return (
		<div className={cn("relative inline-flex", className)} ref={ref}>
			{/* spacer fixes the anchor to the trigger size */}
			<div aria-hidden className="h-11 w-36" />

			{/* Centering box sized to the OPEN panel and centered on the trigger.
			    place-items-center only centers an item that fits its cell, so the cell
			    must be as wide as the panel — otherwise the overflow left-anchors and
			    the panel expands rightward. The box is a fixed size per viewport (vw
			    doesn't change mid-animation), so its -translate centering never drifts
			    the way a content-sized wrapper would. Both states share its center, so
			    the morph grows from the middle outward in every direction. */}
			<div className="pointer-events-none absolute top-1/2 left-1/2 z-30 grid h-[300px] w-[min(86vw,420px)] -translate-x-1/2 -translate-y-1/2 place-items-center [&>*]:pointer-events-auto">
				{/* popLayout pulls the exiting trigger out of grid flow at once, so the
				    grid never briefly holds two rows and shoves the panel off-center */}
				<AnimatePresence initial={false} mode="popLayout">
					{open ? (
						<motion.div
							className="w-[min(86vw,420px)] overflow-hidden bg-card"
							key="panel"
							layoutId={layoutId}
							style={{ borderRadius: 16 }}
							transition={morph}
						>
							<motion.div
								animate={{ opacity: 1 }}
								initial={{ opacity: 0 }}
								// `layout` lets framer undo the box's morph scaling so this
								// content stays crisp instead of stretching with the resize.
								layout
								transition={{ delay: reduce ? 0 : 0.12, duration: 0.2 }}
							>
								{/* header */}
								<div className="flex items-center justify-between border-border border-b px-4 py-3">
									<span className="font-medium text-muted-foreground text-sm">
										{title}
									</span>
									<button
										aria-label="Close menu"
										className="text-muted-foreground transition-colors hover:text-foreground"
										onClick={() => setOpen(false)}
										type="button"
									>
										<X className="h-4 w-4" />
									</button>
								</div>

								{/* grid */}
								<motion.div
									animate={{ clipPath: "inset(0% 0% 0% 0%)" }}
									className="grid grid-cols-3"
									// Iris reveal: start as a small box at the grid center and open
									// outward to all four corners, so the menu grows from the middle
									// in every direction instead of wiping top-down.
									initial={
										reduce ? false : { clipPath: "inset(45% 34% 45% 34%)" }
									}
									transition={{
										delay: reduce ? 0 : 0.08,
										duration: 0.45,
										ease: EASE_OUT,
									}}
								>
									{items.map((item, i) => {
										// Radial stagger: delay each item by its distance from the
										// grid center so the four corners animate together and the
										// open reads as center-out, not corner-by-corner.
										const col = i % GRID_COLS;
										const row = Math.floor(i / GRID_COLS);
										const dist = Math.hypot(
											col - (GRID_COLS - 1) / 2,
											row - (rows - 1) / 2
										);
										const Icon = item.icon;
										return (
											<button
												// Static cell with hairline borders (no animated fill) so
												// the grid lines never flicker as items stagger in. Only the
												// inner content animates.
												className={cn(
													"flex items-center justify-center px-3 py-6 text-muted-foreground transition-colors hover:text-foreground",
													i % GRID_COLS !== GRID_COLS - 1 &&
														"border-border border-r",
													i < GRID_COLS && "border-border border-b"
												)}
												key={item.label}
												onClick={() => {
													item.onSelect();
													setOpen(false);
												}}
												type="button"
											>
												<motion.span
													animate={{
														opacity: 1,
														scale: 1,
														filter: "blur(0px)",
													}}
													className="flex flex-col items-center gap-2"
													initial={
														reduce
															? { opacity: 0 }
															: { opacity: 0, scale: 0.85, filter: "blur(6px)" }
													}
													transition={{
														delay: reduce ? 0 : 0.1 + dist * 0.07,
														type: "spring",
														stiffness: 440,
														damping: 34,
													}}
												>
													<Icon className="h-5 w-5" />
													<span className="font-medium text-sm">
														{item.label}
													</span>
												</motion.span>
											</button>
										);
									})}
								</motion.div>
							</motion.div>
						</motion.div>
					) : (
						<motion.button
							aria-expanded={open}
							aria-haspopup="menu"
							className="inline-flex h-11 w-36 items-center justify-center bg-card font-medium text-foreground text-sm"
							key="trigger"
							layoutId={layoutId}
							onClick={() => setOpen(true)}
							style={{ borderRadius: 16 }}
							transition={morph}
							type="button"
							whileTap={reduce ? undefined : { scale: 0.97 }}
						>
							{/* own `layout` counter-scales the label so it stays crisp while the
							    button box morphs, instead of stretching with it */}
							<motion.span
								className="inline-flex items-center gap-2 whitespace-nowrap"
								layout
							>
								{triggerLabel}
								<Plus className="h-4 w-4" />
							</motion.span>
						</motion.button>
					)}
				</AnimatePresence>
			</div>
		</div>
	);
}
