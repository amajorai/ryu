"use client";

import { SPRING_MORPH } from "@ryu/ui/lib/ease";
import { cn } from "@ryu/ui/lib/utils";
import { motion, type Transition, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const MORPH_SPRING: Transition = SPRING_MORPH;
const CONTENT_FADE = 0.14;
const OPEN_CONTENT_DELAY = 0.06;
const REDUCED_TRANSITION: Transition = { duration: 0.15, ease: "easeOut" };
const DEFAULT_TRIGGER_SIZE = 40;
const DEFAULT_CONTENT_WIDTH = 400;
const PANEL_BORDER_RADIUS = 22;

export interface RyuAssistantMorphProps {
	/** Glass fill and text colour for the morphing surface. */
	bgClassName?: string;
	children: ReactNode;
	/** Ring, shadow, blur, or native-material chrome for the surface. */
	chromeClassName?: string;
	/** Positioning for the fixed wrapper. */
	className?: string;
	contentHeight: number;
	contentMaxHeight?: number | string;
	contentMaxWidth?: number | string;
	contentWidth?: number;
	dismissable?: boolean;
	isOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	style?: CSSProperties;
	trigger?: ReactNode;
	triggerClassName?: string;
	triggerLabel?: string;
	triggerSize?: number;
}

/**
 * A reusable single-surface morph from a compact launcher into an assistant
 * panel. The content remains mounted through the closing animation and is then
 * removed, which makes it safe for chat hooks that must tear down on close.
 */
export function RyuAssistantMorph({
	bgClassName = "bg-primary text-primary-foreground",
	children,
	chromeClassName,
	className,
	contentHeight,
	contentMaxHeight,
	contentMaxWidth,
	contentWidth = DEFAULT_CONTENT_WIDTH,
	dismissable = true,
	isOpen: controlledIsOpen,
	onOpenChange,
	trigger,
	triggerClassName,
	triggerLabel,
	triggerSize = DEFAULT_TRIGGER_SIZE,
	style,
}: RyuAssistantMorphProps) {
	const prefersReducedMotion = useReducedMotion();
	const transition = prefersReducedMotion ? REDUCED_TRANSITION : MORPH_SPRING;
	const isControlled = controlledIsOpen !== undefined;
	const [internalIsOpen, setInternalIsOpen] = useState(false);
	const isOpen = isControlled ? controlledIsOpen : internalIsOpen;
	const [rendered, setRendered] = useState(isOpen);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (isOpen) {
			setRendered(true);
		}
	}, [isOpen]);

	const setIsOpen = useCallback(
		(open: boolean) => {
			if (!isControlled) {
				setInternalIsOpen(open);
			}
			onOpenChange?.(open);
		},
		[isControlled, onOpenChange]
	);

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
	}, [dismissable, isOpen, setIsOpen]);

	const triggerRadius = triggerSize / 2;
	return (
		<div className={className} ref={containerRef} style={style}>
			<motion.div
				animate={{
					borderRadius: isOpen ? PANEL_BORDER_RADIUS : triggerRadius,
					height: isOpen ? contentHeight : triggerSize,
					width: isOpen ? contentWidth : triggerSize,
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
				style={{ maxHeight: contentMaxHeight, maxWidth: contentMaxWidth }}
				transition={transition}
			>
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
						height: triggerSize,
						pointerEvents: isOpen ? "none" : "auto",
						width: triggerSize,
					}}
					title={triggerLabel}
					transition={{ duration: CONTENT_FADE }}
					type="button"
				>
					{trigger}
				</motion.button>

				{rendered ? (
					<motion.div
						animate={{ opacity: isOpen ? 1 : 0 }}
						aria-hidden={!isOpen}
						className="absolute right-0 bottom-0"
						initial={{ opacity: 0 }}
						role="dialog"
						style={{
							height: "100%",
							pointerEvents: isOpen ? "auto" : "none",
							width: "100%",
						}}
						transition={{
							delay: isOpen ? OPEN_CONTENT_DELAY : 0,
							duration: CONTENT_FADE,
						}}
					>
						{children}
					</motion.div>
				) : null}
			</motion.div>
		</div>
	);
}
