"use client";

import {
	RefreshIcon,
	ServerStack01Icon,
	Tick02Icon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import type { ConnectionPhase } from "@ryuhq/protocol/connection-status";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";
import styles from "./connection-status.module.css";
import { useConnectionStatusStack } from "./connection-status-stack.ts";
import {
	StatusStrip,
	type StatusStripTone,
} from "./connection-status-strip.tsx";
import { Spinner } from "./spinner.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./tooltip.tsx";

/** The compact connection states used by status dots in host navigation. */
export type ConnectionDotState = "checking" | "offline" | "online";

/**
 * A small, accessible connection indicator for dense navigation rows.
 *
 * The host supplies the state and accessible label; this primitive owns the
 * semantic colors so a sidebar, node picker, or app row does not grow its own
 * status palette.
 */
export function ConnectionStatusDot({
	className,
	label,
	state,
}: {
	className?: string;
	label: string;
	state: ConnectionDotState;
}) {
	const tone =
		state === "online"
			? "bg-success"
			: state === "offline"
				? "bg-destructive"
				: "bg-muted-foreground";
	return (
		<span
			aria-label={label}
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				tone,
				className
			)}
			data-connection-dot-state={state}
			role="img"
			title={label}
		/>
	);
}

interface ConnectionStatusCopy {
	detail: string;
	title: string;
}

function isStatusTextClipped(element: HTMLElement | null): boolean {
	return Boolean(element && element.scrollWidth - element.clientWidth > 1);
}

function ConnectionStatusText({
	className,
	dataSlot,
	text,
}: {
	className: string;
	dataSlot: "connection-status-detail" | "connection-status-title";
	text: string;
}) {
	const textRef = useRef<HTMLSpanElement>(null);
	const [clipped, setClipped] = useState(false);
	const [tooltipOpen, setTooltipOpen] = useState(false);

	useEffect(() => {
		const element = textRef.current;
		if (!element) {
			return;
		}

		const measure = () =>
			setClipped(text.length > 0 && isStatusTextClipped(element));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [text]);

	const measureNow = useCallback(
		() => isStatusTextClipped(textRef.current),
		[]
	);

	return (
		<Tooltip
			onOpenChange={(next) => {
				if (next && !measureNow()) {
					return;
				}
				setTooltipOpen(next);
			}}
			open={tooltipOpen}
		>
			<TooltipTrigger
				render={
					<span
						className={cn(
							"block min-w-0 overflow-hidden whitespace-nowrap",
							className,
							clipped && styles.clippedText
						)}
						data-slot={dataSlot}
						ref={textRef}
					>
						{text}
					</span>
				}
			/>
			<TooltipContent
				align="center"
				className="max-w-[calc(100vw-2rem)] whitespace-normal break-words"
				role="tooltip"
				side="bottom"
			>
				{text}
			</TooltipContent>
		</Tooltip>
	);
}

/** Controlled inputs for the shared web/extension connection status surface. */
export interface ConnectionStatusToastProps {
	/** Allows a host to add a class without taking over the component geometry. */
	className?: string;
	/**
	 * "toast" (default) is the floating pill web and extension hosts use;
	 * "strip" is the inline `h-8` banner the desktop shell mounts under its
	 * header.
	 */
	layout?: "strip" | "toast";
	/** The selected node shown in the node-unreachable and reconnecting copy. */
	nodeName?: string;
	/** Optional manual retry action. It is only shown for node-unreachable. */
	onRetry?: () => void;
	phase: ConnectionPhase;
	/** Brief success state shown after the host moves from unavailable to online. */
	restored?: boolean;
	retrying?: boolean;
}

/** Backwards-compatible name for callers that use the presentational view. */
export type ConnectionStatusToastViewProps = ConnectionStatusToastProps;

function copyForPhase(
	phase: ConnectionPhase,
	nodeName: string,
	restored: boolean,
	tl: LiteralMessage
): ConnectionStatusCopy {
	if (restored) {
		return {
			detail: tl("Reconnected to {nodeName}.", { nodeName }),
			title: "Connection restored",
		};
	}
	if (phase === "offline") {
		return {
			detail: "Waiting for connectivity…",
			title: "Offline mode",
		};
	}
	if (phase === "node-unreachable") {
		return {
			detail: tl("Can’t reach {nodeName}. Reconnecting automatically…", {
				nodeName,
			}),
			title: "Node offline",
		};
	}
	return {
		detail: "Checking the node and keeping this window available…",
		title: tl("Connecting to {nodeName}", { nodeName }),
	};
}

function phaseIcon(
	phase: ConnectionPhase,
	restored: boolean,
	className = "size-3.5"
): ReactNode {
	if (restored) {
		return (
			<HugeiconsIcon
				aria-hidden="true"
				className={className}
				icon={Tick02Icon}
			/>
		);
	}
	if (phase === "offline") {
		return (
			<HugeiconsIcon
				aria-hidden="true"
				className={className}
				icon={WifiDisconnected01Icon}
			/>
		);
	}
	if (phase === "node-unreachable") {
		return (
			<HugeiconsIcon
				aria-hidden="true"
				className={className}
				icon={ServerStack01Icon}
			/>
		);
	}
	return <Spinner aria-hidden="true" className={className} />;
}

function phaseTone(phase: ConnectionPhase, restored: boolean): StatusStripTone {
	if (restored) {
		return "success";
	}
	if (phase === "node-unreachable") {
		return "warning";
	}
	return "neutral";
}

function phaseIconClass(phase: ConnectionPhase, restored: boolean): string {
	if (restored) {
		return "bg-status-success/15 text-status-success";
	}
	if (phase === "checking" || phase === "offline") {
		return "bg-status-info/15 text-status-info";
	}
	return "bg-status-warning/15 text-status-warning";
}

const STATUS_MOTION = { type: "spring", duration: 0.3, bounce: 0 } as const;
const STATUS_EXIT = { type: "spring", duration: 0.2, bounce: 0 } as const;

/**
 * Compact fixed status surface for web hosts.
 *
 * It intentionally owns no network calls or node state. A host supplies the
 * same four-phase contract and can therefore use this in the shell, Gateway,
 * Spaces, databases, multiplayer, or a standalone app surface.
 */
interface ToastStyle extends CSSProperties {
	"--toast-opacity"?: number;
	"--toast-pointer-events"?: string;
	"--toast-width"?: string;
	"--toast-z-index"?: number;
}

export function ConnectionStatusToast(props: ConnectionStatusToastProps) {
	if (props.layout === "strip") {
		return <ConnectionStatusStrip {...props} />;
	}
	return <ConnectionStatusFloating {...props} />;
}

/** The inline desktop banner: one sentence and, when unreachable, one Retry. */
function ConnectionStatusStrip({
	className,
	nodeName = "Ryu",
	onRetry,
	phase,
	restored = false,
	retrying = false,
}: ConnectionStatusToastProps) {
	const tl = useLiteralMessages();
	if (phase === "online" && !restored) {
		return null;
	}
	const copy = copyForPhase(phase, nodeName, restored, tl);
	return (
		<StatusStrip
			action={
				phase === "node-unreachable" && onRetry ? (
					<Button
						data-slot="connection-status-retry"
						disabled={retrying}
						onClick={onRetry}
						size="sm"
						variant="ghost"
					>
						{retrying ? "Checking…" : "Retry"}
					</Button>
				) : null
			}
			className={className}
			data-connection-phase={phase}
			data-connection-restored={restored ? "true" : undefined}
			data-testid="connection-status-toast"
			detail={copy.detail}
			icon={phaseIcon(phase, restored, "size-4")}
			title={`${copy.title}.`}
			tone={phaseTone(phase, restored)}
		/>
	);
}

function ConnectionStatusFloating({
	className,
	nodeName = "Ryu",
	onRetry,
	phase,
	restored = false,
	retrying = false,
}: ConnectionStatusToastProps) {
	const tl = useLiteralMessages();
	const visible = phase !== "online" || restored;
	const reducedMotion = useReducedMotion();
	const stack = useConnectionStatusStack(visible);
	const contentVisible = stack.index === 0 || stack.expanded;
	const stateKey = restored ? "restored" : phase;
	const transition = reducedMotion ? { duration: 0 } : STATUS_MOTION;

	const copy = copyForPhase(phase, nodeName, restored, tl);
	const stackStyle: ToastStyle = {
		"--toast-z-index": 100 - Math.min(stack.index, 99),
	};
	const surfaceStyle: ToastStyle = {
		"--toast-width": contentVisible ? undefined : `${stack.frontWidth}px`,
		"--toast-pointer-events":
			stack.index < 3 || stack.expanded ? "auto" : "none",
	};
	const retryStyle: ToastStyle = { "--toast-opacity": contentVisible ? 1 : 0 };

	return (
		<TooltipProvider delay={0}>
			<AnimatePresence>
				{visible && (
					<motion.div
						animate={{ opacity: stack.opacity, y: stack.y, scale: stack.scale }}
						className={cn(
							"pointer-events-none fixed inset-x-0 top-12 z-(--toast-z-index) flex origin-top justify-center px-4 sm:px-6",
							className
						)}
						data-connection-phase={phase}
						data-connection-restored={restored ? "true" : undefined}
						data-stack-expanded={stack.expanded}
						data-stack-index={stack.index}
						data-testid="connection-status-toast"
						exit={{
							opacity: 0,
							y: -20,
							scale: reducedMotion ? 1 : 0.95,
							transition: reducedMotion ? { duration: 0 } : STATUS_EXIT,
						}}
						initial={
							reducedMotion ? false : { opacity: 0, y: -20, scale: 0.95 }
						}
						style={stackStyle}
						transition={transition}
					>
						<motion.div
							aria-live="polite"
							className={cn(
								"relative flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full bg-connection-toast-surface/65 py-1.5 pr-4 pl-2 text-white shadow-[0_14px_35px_-16px_rgba(0,0,0,0.72)] backdrop-blur-2xl backdrop-saturate-150",
								styles.surface
							)}
							data-slot="connection-status-surface"
							layout={reducedMotion ? false : "size"}
							onBlurCapture={(event) => {
								if (!event.currentTarget.contains(event.relatedTarget)) {
									stack.setFocused(false);
								}
							}}
							onFocusCapture={() => stack.setFocused(true)}
							onHoverEnd={() => stack.setHovered(false)}
							onHoverStart={() => stack.setHovered(true)}
							ref={stack.surfaceRef}
							role="status"
							style={surfaceStyle}
							transition={transition}
						>
							<motion.span
								animate={{
									opacity: contentVisible ? 1 : 0,
									scale: 1,
									filter: "blur(0px)",
								}}
								aria-hidden="true"
								className={cn(
									"flex size-7 shrink-0 items-center justify-center rounded-full",
									phaseIconClass(phase, restored)
								)}
								initial={
									reducedMotion
										? false
										: { opacity: 0, scale: 0.25, filter: "blur(4px)" }
								}
								key={stateKey}
								transition={transition}
							>
								{phaseIcon(phase, restored)}
							</motion.span>
							<motion.span
								animate={{
									opacity: contentVisible ? 1 : 0,
									filter: "blur(0px)",
									y: 0,
								}}
								className="min-w-0 flex-1 py-0.5"
								initial={
									reducedMotion
										? false
										: { opacity: 0, filter: "blur(4px)", y: 4 }
								}
								key={`${stateKey}:${nodeName}`}
								transition={
									reducedMotion
										? { duration: 0 }
										: { duration: 0.24, delay: 0.04 }
								}
							>
								<ConnectionStatusText
									className="text-center font-medium text-xs"
									dataSlot="connection-status-title"
									text={copy.title}
								/>
								<ConnectionStatusText
									className="text-center text-white/60 text-xs"
									dataSlot="connection-status-detail"
									text={copy.detail}
								/>
							</motion.span>
							{phase === "node-unreachable" && onRetry ? (
								<Button
									aria-label={retrying ? "Checking connection" : "Retry"}
									className="size-7 shrink-0 rounded-full border border-white/10 bg-white/10 p-0 text-white/90 opacity-(--toast-opacity) shadow-none hover:bg-white/15 hover:text-white focus-visible:border-white/30 focus-visible:ring-white/30"
									data-slot="connection-status-retry"
									disabled={retrying}
									onClick={onRetry}
									size="icon-xs"
									style={retryStyle}
									title={retrying ? "Checking connection" : "Retry connection"}
									variant="ghost"
								>
									<HugeiconsIcon
										aria-hidden="true"
										className={cn("size-3.5", retrying && "animate-spin")}
										icon={RefreshIcon}
									/>
									<span className="sr-only">
										{retrying ? "Checking connection" : "Retry"}
									</span>
								</Button>
							) : null}
						</motion.div>
					</motion.div>
				)}
			</AnimatePresence>
		</TooltipProvider>
	);
}

/** Explicit alias for hosts that distinguish the view from their adapter. */
export const ConnectionStatusToastView = ConnectionStatusToast;

export type { ConnectionPhase } from "@ryuhq/protocol/connection-status";
