// apps/desktop/src/components/watermelon-ui/floating-disclosure.tsx
//
// Adapted from registry.watermelon.sh/r/floating-disclosure — a "+" trigger that
// discloses a floating card of labelled create actions, each row blurring in with
// a staggered upward bloom while the "+" rotates into an "×". Ported onto this
// repo's stack: framer-motion (not motion/react), @ryu/ui's `cn`, hugeicons action
// icons via `HugeiconsIcon` (matching GooeyMenu's action shape), theme tokens for
// light/dark parity, real <button>s + aria for accessibility, and honoring
// prefers-reduced-motion.
//
// The registry morphs a single surface between its collapsed and expanded size by
// measuring it with a ResizeObserver. In a compact sidebar-footer icon slot that
// measure→animate→resize cycle feeds itself into a "ResizeObserver loop" and never
// settles, so here the panel is a fixed-width popover anchored above the trigger
// (bottom-full) with a scale/opacity reveal — stable, and it never shifts the
// footer's other buttons.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	AnimatePresence,
	motion,
	type Transition,
	useReducedMotion,
} from "framer-motion";
import { useEffect, useRef, useState } from "react";

export interface FloatingDisclosureItem {
	description?: string;
	icon: IconSvgElement;
	id: string;
	label: string;
	onSelect: () => void;
}

export interface FloatingDisclosureProps {
	className?: string;
	items: FloatingDisclosureItem[];
	label?: string;
}

export function FloatingDisclosure({
	items,
	label = "Create",
	className,
}: FloatingDisclosureProps) {
	const reduce = useReducedMotion();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	// Close on outside pointerdown or Escape — the popover has no backdrop.
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

	const panelSpring: Transition = reduce
		? { duration: 0 }
		: { type: "spring", stiffness: 320, damping: 28 };

	const rowSpring = (index: number): Transition =>
		reduce
			? { duration: 0 }
			: { delay: index * 0.04, type: "spring", stiffness: 240, damping: 22 };

	return (
		<div className={cn("relative size-7 shrink-0", className)} ref={rootRef}>
			<AnimatePresence>
				{open && (
					<motion.div
						animate={{ opacity: 1, scale: 1, y: 0 }}
						className="absolute right-0 bottom-full z-50 mb-2 w-60 origin-bottom-right overflow-hidden rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
						exit={{ opacity: 0, scale: 0.92, y: 8 }}
						initial={{ opacity: 0, scale: 0.92, y: 8 }}
						key="panel"
						transition={panelSpring}
					>
						<div className="flex flex-col gap-0.5">
							{items.map((item, index) => (
								<motion.button
									animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
									className="flex w-full shrink-0 items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors hover:bg-accent"
									initial={
										reduce
											? { opacity: 0 }
											: { opacity: 0, filter: "blur(4px)", y: 12 }
									}
									key={item.id}
									onClick={() => {
										item.onSelect();
										setOpen(false);
									}}
									transition={rowSpring(index)}
									type="button"
								>
									<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
										<HugeiconsIcon icon={item.icon} size={16} />
									</span>
									<span className="flex min-w-0 flex-col leading-tight">
										<span className="truncate font-medium text-foreground text-sm">
											{item.label}
										</span>
										{item.description && (
											<span className="truncate text-muted-foreground text-xs">
												{item.description}
											</span>
										)}
									</span>
								</motion.button>
							))}
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			<button
				aria-expanded={open}
				aria-label={label}
				className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
				onClick={() => setOpen((prev) => !prev)}
				type="button"
			>
				<motion.span
					animate={{ rotate: open ? 45 : 0 }}
					className="flex"
					transition={reduce ? { duration: 0 } : { duration: 0.2 }}
				>
					<HugeiconsIcon icon={Add01Icon} size={16} />
				</motion.span>
			</button>
		</div>
	);
}
