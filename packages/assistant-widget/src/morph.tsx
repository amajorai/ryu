"use client";

import { SPRING_MORPH } from "@ryu/ui/lib/ease";
import { cn } from "@ryu/ui/lib/utils";
import { motion, type Transition, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cssDimension } from "./css-dimension.ts";
import styles from "./morph.module.css";

interface MorphGeometryStyle extends CSSProperties {
	"--assistant-morph-max-height": string | undefined;
	"--assistant-morph-max-width": string | undefined;
}
interface MorphTriggerStyle extends CSSProperties {
	"--assistant-morph-trigger-size": string | undefined;
}

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
	dialogLabel?: string;
	dismissable?: boolean;
	isOpen?: boolean;
	/**
	 * Keep the content mounted (hidden and inert) after its first open, so state
	 * held inside it, such as a lazily loaded chat session, survives closing.
	 */
	keepContentMounted?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** Called when the visitor shows intent to open (pointer enters or focus lands on the trigger), e.g. to warm a lazy panel. */
	onTriggerIntent?: () => void;
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
 * With `keepContentMounted` it is instead hidden once the close settles, so a
 * session living inside it keeps its state. Closing content is always inert.
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
	dialogLabel,
	isOpen: controlledIsOpen,
	keepContentMounted = false,
	onOpenChange,
	onTriggerIntent,
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
	// `rendered`: showing or animating. `kept`: opened at least once.
	const [rendered, setRendered] = useState(isOpen);
	const [kept, setKept] = useState(isOpen);
	const containerRef = useRef<HTMLDivElement>(null);
	const mountContent = rendered || (keepContentMounted && kept);

	useEffect(() => {
		if (isOpen) {
			setRendered(true);
			setKept(true);
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
			const target = event.target;
			if (
				target instanceof window.Node &&
				!containerRef.current?.contains(target)
			) {
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
	const geometry: MorphGeometryStyle = {
		"--assistant-morph-max-height": cssDimension(contentMaxHeight),
		"--assistant-morph-max-width": cssDimension(contentMaxWidth),
	};
	const triggerGeometry: MorphTriggerStyle = {
		"--assistant-morph-trigger-size": cssDimension(triggerSize),
	};
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
					styles.panel,
					bgClassName,
					chromeClassName
				)}
				initial={false}
				onAnimationComplete={() => {
					if (!isOpen) {
						setRendered(false);
					}
				}}
				style={geometry}
				transition={transition}
			>
				<motion.button
					animate={{ opacity: isOpen ? 0 : 1 }}
					aria-expanded={isOpen}
					aria-haspopup="dialog"
					aria-label={triggerLabel}
					className={cn(
						"absolute right-0 bottom-0 flex items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
						styles.trigger,
						triggerClassName
					)}
					onClick={() => setIsOpen(!isOpen)}
					onFocus={onTriggerIntent}
					onPointerEnter={onTriggerIntent}
					style={triggerGeometry}
					title={triggerLabel}
					transition={{ duration: CONTENT_FADE }}
					type="button"
				>
					{trigger}
				</motion.button>

				{mountContent ? (
					<motion.div
						animate={{ opacity: isOpen ? 1 : 0 }}
						aria-hidden={!isOpen}
						aria-label={dialogLabel ?? triggerLabel ?? "Assistant"}
						className={cn("absolute right-0 bottom-0", styles.content)}
						hidden={!(isOpen || rendered)}
						inert={!isOpen}
						initial={{ opacity: 0 }}
						role="dialog"
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
