"use client";

import { cn } from "@ryu/ui/lib/utils";
import { motion, type Transition, useReducedMotion } from "framer-motion";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

// One surface, one spring. Instead of a gooey two-layer blob morph, the trigger
// circle and the content panel are the SAME box: a single glass card pinned to
// its bottom-right corner that springs between the 40px launcher and the full
// panel, growing up-and-left as its width/height animate (right/bottom stay
// pinned, so no x/y translate math). The eyes and the chat body crossfade inside
// it. Modelled on the beui feedback-widget morph — calm, crisp, no filter.
const MORPH_SPRING: Transition = {
	type: "spring",
	stiffness: 320,
	damping: 34,
	mass: 0.9,
};
// Content crossfade: fast opacity swap while the shell springs. Opening waits a
// beat so the box is already growing before the panel reads in.
const CONTENT_FADE = 0.14;
const OPEN_CONTENT_DELAY = 0.06;
// Reduced motion drops the spring for a plain, near-instant resize + fade.
const REDUCED_TRANSITION: Transition = { duration: 0.15, ease: "easeOut" };

const DEFAULT_TRIGGER_SIZE = 40;
const DEFAULT_CONTENT_WIDTH = 400;
// The launcher circle and the open panel share the same visual language: the
// radius barely moves (a full circle at rest, a soft-cornered card open), so the
// morph reads as one surface relaxing rather than two shapes swapping.
const PANEL_BORDER_RADIUS = 22;

export interface MorphPopoverProps {
	/** The glass fill + text color, applied to the single morphing surface. */
	bgClassName?: string;
	children: React.ReactNode;
	/** Chrome for the surface: ring, backdrop blur, shadow. Always on (one card). */
	chromeClassName?: string;
	/** Positioning for the fixed wrapper (e.g. `fixed right-4 bottom-4 z-50`). */
	className?: string;
	contentHeight: number;
	contentWidth?: number;
	/** Close on outside click / Escape. Off for persistent surfaces. */
	dismissable?: boolean;
	isOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	trigger?: React.ReactNode;
	triggerClassName?: string;
	triggerLabel?: string;
	triggerSize?: number;
}

/**
 * A clean, single-surface morphing popover: one glass card springs from a round
 * launcher into a content panel and back. The launcher IS the panel — there is
 * no separate persistent button and no goo bridge — so opening reads as the
 * button relaxing open. Dismissal, when the surface has no launcher visible
 * (open), is the caller's responsibility (the panel's own controls); set
 * `dismissable` to also close on outside click / Escape. Honors
 * `prefers-reduced-motion` by dropping the spring for a plain resize + fade.
 */
export function MorphPopover({
	children,
	trigger,
	triggerLabel,
	triggerClassName,
	triggerSize = DEFAULT_TRIGGER_SIZE,
	isOpen: controlledIsOpen,
	onOpenChange,
	contentWidth = DEFAULT_CONTENT_WIDTH,
	contentHeight,
	dismissable = true,
	bgClassName = "bg-primary text-primary-foreground",
	chromeClassName,
	className,
}: MorphPopoverProps) {
	const prefersReducedMotion = useReducedMotion();
	const transition = prefersReducedMotion ? REDUCED_TRANSITION : MORPH_SPRING;

	const isControlled = controlledIsOpen !== undefined;
	const [internalIsOpen, setInternalIsOpen] = useState(false);
	const isOpen = isControlled ? controlledIsOpen : internalIsOpen;

	// Keep the (expensive) children mounted through the closing morph, then unmount
	// once the shell has collapsed back to the launcher. Unmounting on close is
	// load-bearing for the Ask-Ryu panel: its `useChat` must be gone before the
	// "open full screen" hand-off mounts a /chat tab on the same conversation id.
	const [rendered, setRendered] = useState(isOpen);
	useEffect(() => {
		if (isOpen) {
			setRendered(true);
		}
	}, [isOpen]);

	const containerRef = useRef<HTMLDivElement>(null);

	const setIsOpen = useCallback(
		(open: boolean) => {
			if (!isControlled) {
				setInternalIsOpen(open);
			}
			onOpenChange?.(open);
		},
		[isControlled, onOpenChange]
	);

	// Close on outside click / Escape.
	useEffect(() => {
		if (!(isOpen && dismissable)) {
			return;
		}
		const onPointerDown = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (target && !containerRef.current?.contains(target)) {
				setIsOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setIsOpen(false);
			}
		};
		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [isOpen, dismissable, setIsOpen]);

	const triggerRadius = triggerSize / 2;

	return (
		<div className={className} ref={containerRef}>
			{/* The single morphing surface, pinned bottom-right so growing its size
			    expands it up and to the left with no translate. */}
			<motion.div
				animate={{
					width: isOpen ? contentWidth : triggerSize,
					height: isOpen ? contentHeight : triggerSize,
					borderRadius: isOpen ? PANEL_BORDER_RADIUS : triggerRadius,
				}}
				className={cn(
					"absolute right-0 bottom-0 overflow-hidden",
					bgClassName,
					chromeClassName
				)}
				initial={false}
				onAnimationComplete={() => {
					if (!isOpen) {
						setRendered(false);
					}
				}}
				transition={transition}
			>
				{/* Launcher eyes: fill the resting circle, fade out as it opens. Sits
				    bottom-right so it stays put in the corner while the box grows. */}
				<motion.button
					animate={{ opacity: isOpen ? 0 : 1 }}
					aria-expanded={isOpen}
					aria-haspopup="dialog"
					aria-label={triggerLabel}
					className={cn(
						"absolute right-0 bottom-0 flex items-center justify-center rounded-full outline-none",
						triggerClassName
					)}
					onClick={() => setIsOpen(!isOpen)}
					style={{
						width: triggerSize,
						height: triggerSize,
						pointerEvents: isOpen ? "none" : "auto",
					}}
					title={triggerLabel}
					transition={{ duration: CONTENT_FADE }}
					type="button"
				>
					{trigger}
				</motion.button>

				{/* The content panel: sized to the open surface, anchored bottom-right so
				    it never slides during the morph — it's clipped while collapsed, then
				    crossfades in once the box has started growing. Mounted only while
				    open (plus the closing morph) so its `useChat` is torn down on close. */}
				{rendered && (
					<motion.div
						animate={{ opacity: isOpen ? 1 : 0 }}
						aria-hidden={!isOpen}
						className="absolute right-0 bottom-0"
						initial={{ opacity: 0 }}
						role="dialog"
						style={{
							width: contentWidth,
							height: contentHeight,
							pointerEvents: isOpen ? "auto" : "none",
						}}
						transition={{
							duration: CONTENT_FADE,
							delay: isOpen ? OPEN_CONTENT_DELAY : 0,
						}}
					>
						{children}
					</motion.div>
				)}
			</motion.div>
		</div>
	);
}
