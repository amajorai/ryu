"use client";

import { cn } from "@ryu/ui/lib/utils";
import { motion, type Transition, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { cssDimension } from "./css-dimension.ts";
import styles from "./morph.module.css";

interface MorphGeometryStyle extends CSSProperties {
	"--assistant-morph-max-height": string | undefined;
	"--assistant-morph-max-width": string | undefined;
}
interface MorphTriggerStyle extends CSSProperties {
	"--assistant-morph-trigger-size": string | undefined;
}

/** Enter: `--duration-slow` on `--ease-enter`. Exit: 150ms on `--ease-exit`. */
const ENTER_TRANSITION: Transition = {
	duration: 0.28,
	ease: [0.19, 1, 0.22, 1],
};
const EXIT_TRANSITION: Transition = { duration: 0.15, ease: [0.4, 0, 1, 1] };
const REDUCED_TRANSITION: Transition = { duration: 0.09, ease: "linear" };
const DEFAULT_TRIGGER_SIZE = 40;
const DEFAULT_CONTENT_WIDTH = 400;
/** `rounded-2xl`: the one radius for the open widget and the Island panel. */
const PANEL_BORDER_RADIUS = 16;
const OPEN_SCALE = 0.97;
const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The clip that shows only the launcher's circle in the panel's corner. */
function collapsedClip(width: number, height: number, trigger: number) {
	const radius = trigger / 2;
	return `inset(${Math.max(0, height - trigger)}px 0px 0px ${Math.max(0, width - trigger)}px round ${radius}px)`;
}
const OPEN_CLIP = `inset(0px 0px 0px 0px round ${PANEL_BORDER_RADIUS}px)`;

/** Keep Tab inside the open panel, cycling at both ends. */
function trapTab(event: KeyboardEvent, root: HTMLElement | null) {
	if (event.key !== "Tab" || !root) {
		return;
	}
	const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
	const first = focusable[0];
	const last = focusable.at(-1);
	if (!(first && last)) {
		event.preventDefault();
		root.focus();
		return;
	}
	const active = document.activeElement;
	if (event.shiftKey && (active === first || active === root)) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && active === last) {
		event.preventDefault();
		first.focus();
	}
}

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
 * A compact launcher that opens an assistant panel. The panel renders at its
 * final size and reveals itself from the launcher's corner with a clip-path,
 * scale and opacity (280ms in, 150ms out; opacity only under reduced motion),
 * so its layout never reflows mid-animation. Focus moves into the open panel,
 * Tab stays inside it, and closing returns focus to the launcher, which is out
 * of the tab order while the panel is open. The content remains mounted
 * through the closing animation and is then removed, which makes it safe for
 * chat hooks that must tear down on close. With `keepContentMounted` it is
 * instead hidden once the close settles, so a session living inside it keeps
 * its state. Closing content is always inert.
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
	const isControlled = controlledIsOpen !== undefined;
	const [internalIsOpen, setInternalIsOpen] = useState(false);
	const isOpen = isControlled ? controlledIsOpen : internalIsOpen;
	// `rendered`: showing or animating. `kept`: opened at least once.
	const [rendered, setRendered] = useState(isOpen);
	const [kept, setKept] = useState(isOpen);
	const mountContent = rendered || (keepContentMounted && kept);
	const containerRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [panelSize, setPanelSize] = useState({
		height: contentHeight,
		width: contentWidth,
	});

	useEffect(() => {
		if (isOpen) {
			setRendered(true);
			setKept(true);
		}
	}, [isOpen]);

	// Measure the rendered panel (max-width/height may clamp it) so the closed
	// clip lands exactly on the launcher's circle.
	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!(rendered && panel)) {
			return;
		}
		const { height, width } = panel.getBoundingClientRect();
		if (width > 0 && height > 0) {
			setPanelSize({ height, width });
		}
	}, [rendered]);

	const setIsOpen = useCallback(
		(open: boolean) => {
			if (!isControlled) {
				setInternalIsOpen(open);
			}
			onOpenChange?.(open);
		},
		[isControlled, onOpenChange]
	);

	// Focus moves into the panel when it opens (not when it mounts open), and
	// back to the launcher when it closes while focus was inside it.
	const wasOpen = useRef(isOpen);
	const focusOnOpen = useRef(false);
	useEffect(() => {
		if (isOpen && !wasOpen.current) {
			focusOnOpen.current = true;
		}
		if (
			!isOpen &&
			wasOpen.current &&
			panelRef.current?.contains(document.activeElement)
		) {
			triggerRef.current?.focus({ preventScroll: true });
		}
		wasOpen.current = isOpen;
	}, [isOpen]);
	useEffect(() => {
		const panel = panelRef.current;
		if (!(isOpen && rendered && panel && focusOnOpen.current)) {
			return;
		}
		focusOnOpen.current = false;
		const target = panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
		target.focus({ preventScroll: true });
	}, [isOpen, rendered]);

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && dismissable) {
				setIsOpen(false);
				return;
			}
			trapTab(event, panelRef.current);
		};
		const onPointerDown = (event: MouseEvent) => {
			const target = event.target;
			if (
				dismissable &&
				target instanceof window.Node &&
				!containerRef.current?.contains(target)
			) {
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

	const geometry: MorphGeometryStyle = {
		"--assistant-morph-max-height": cssDimension(contentMaxHeight),
		"--assistant-morph-max-width": cssDimension(contentMaxWidth),
		height: contentHeight,
		width: contentWidth,
	};
	const triggerGeometry: MorphTriggerStyle = {
		"--assistant-morph-trigger-size": cssDimension(triggerSize),
	};
	const closedClip = collapsedClip(
		panelSize.width,
		panelSize.height,
		triggerSize
	);
	const panelTransition = prefersReducedMotion
		? REDUCED_TRANSITION
		: isOpen
			? ENTER_TRANSITION
			: EXIT_TRANSITION;
	const closedState = prefersReducedMotion
		? { clipPath: OPEN_CLIP, opacity: 0, scale: 1 }
		: { clipPath: closedClip, opacity: 0, scale: OPEN_SCALE };
	return (
		<div className={className} ref={containerRef} style={style}>
			<motion.button
				animate={{ opacity: isOpen ? 0 : 1 }}
				aria-expanded={isOpen}
				aria-haspopup="dialog"
				aria-label={triggerLabel}
				className={cn(
					"absolute right-0 bottom-0 flex items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
					styles.trigger,
					bgClassName,
					chromeClassName,
					triggerClassName
				)}
				initial={false}
				onClick={() => setIsOpen(!isOpen)}
				onFocus={onTriggerIntent}
				onPointerEnter={onTriggerIntent}
				ref={triggerRef}
				style={triggerGeometry}
				tabIndex={isOpen ? -1 : 0}
				title={triggerLabel}
				transition={panelTransition}
				type="button"
			>
				{trigger}
			</motion.button>

			{mountContent ? (
				<motion.div
					animate={
						isOpen ? { clipPath: OPEN_CLIP, opacity: 1, scale: 1 } : closedState
					}
					aria-hidden={!isOpen}
					aria-label={dialogLabel ?? triggerLabel ?? "Assistant"}
					aria-modal="false"
					className={cn(
						"absolute right-0 bottom-0 origin-bottom-right overflow-hidden rounded-2xl outline-none",
						styles.panel,
						styles.content,
						bgClassName,
						chromeClassName
					)}
					hidden={!(isOpen || rendered)}
					inert={!isOpen}
					initial={closedState}
					onAnimationComplete={() => {
						if (!isOpen) {
							setRendered(false);
						}
					}}
					ref={panelRef}
					role="dialog"
					style={geometry}
					tabIndex={-1}
					transition={panelTransition}
				>
					{children}
				</motion.div>
			) : null}
		</div>
	);
}
