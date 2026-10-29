"use client";

// beui.dev/components/agents/agent-activity

import type { CSSProperties } from "react";
import css from "./index.module.css";

interface Inline1Style extends CSSProperties {
	"--index-1-height"?: CSSProperties["height"];
}

import { AgentDisclosure } from "@ryu/ui/components/agents/agent-disclosure.tsx";
import { ThinkingShimmer } from "@ryu/ui/components/agents/loading-states/thinking-shimmer.tsx";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ChevronDown, Globe2, ListChecks, Wrench } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { ActivityRow } from "./activity-row.tsx";
import type {
	AgentActivityContentType,
	AgentActivityItem,
	AgentActivityProps,
} from "./types.ts";

export type {
	AgentActivityContentType,
	AgentActivityItem,
	AgentActivityProps,
	AgentActivitySearch,
	AgentActivityStatus,
	AgentActivityStep,
	AgentActivityText,
	AgentActivityTool,
	AgentActivityTrace,
	AgentSearchResult,
	AgentStepStatus,
	AgentTraceKind,
} from "./types.ts";

function formatDuration(duration: number) {
	const seconds = Math.max(0, Math.round(duration));
	if (seconds < 60) {
		return `${seconds}s`;
	}

	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function useControllableOpen({
	open,
	defaultOpen,
	onOpenChange,
}: {
	open?: boolean;
	defaultOpen: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [internalOpen, setInternalOpen] = useState(defaultOpen);
	const controlled = open !== undefined;
	const currentOpen = open ?? internalOpen;

	const setOpen = useCallback(
		(next: boolean) => {
			if (!controlled) {
				setInternalOpen(next);
			}
			onOpenChange?.(next);
		},
		[controlled, onOpenChange]
	);

	return [currentOpen, setOpen] as const;
}

function getContentType(items: AgentActivityItem[]): AgentActivityContentType {
	const first = items[0]?.type;
	return first && items.every((item) => item.type === first) ? first : "mixed";
}

function getActiveLabel(type: AgentActivityContentType) {
	if (type === "search") {
		return "Searching the web…";
	}
	if (type === "tool") {
		return "Running tools…";
	}
	if (type === "trace") {
		return "Working through the run…";
	}
	if (type === "mixed") {
		return "Working through it…";
	}
	return "Thinking…";
}

function ActivityIcon({ type }: { type: AgentActivityContentType }) {
	if (type === "search") {
		return <Globe2 className="size-4" />;
	}
	if (type === "tool") {
		return <Wrench className="size-4" />;
	}
	return <ListChecks className="size-4" />;
}

function getSummary(
	type: AgentActivityContentType,
	items: AgentActivityItem[],
	duration: number
): ReactNode {
	if (type === "step" || type === "text") {
		return (
			<>
				Thought for{" "}
				<span className="tabular-nums">{formatDuration(duration)}</span>
			</>
		);
	}
	if (type === "search") {
		return "Searched the web";
	}
	if (type === "tool") {
		return `Ran ${items.length} ${items.length === 1 ? "tool" : "tools"}`;
	}
	if (type === "trace") {
		const messages = items.filter(
			(item) =>
				item.type === "trace" &&
				(item.kind === "thinking" || item.kind === "message")
		).length;
		const tools = items.length - messages;
		return `${tools} ${tools === 1 ? "tool call" : "tool calls"}, ${messages} ${messages === 1 ? "message" : "messages"}`;
	}
	return `Completed ${items.length} ${items.length === 1 ? "step" : "steps"}`;
}

export function AgentActivity({
	items,
	contentType: initialContentType,
	status = "working",
	duration = 0,
	open,
	defaultOpen = false,
	onOpenChange,
	collapseOnComplete = true,
	activeLabel,
	summary,
	maxHeight = 208,
	className,
	contentClassName,
}: AgentActivityProps) {
	const reduce = useReducedMotion() ?? false;
	const baseId = useId();
	const triggerId = `${baseId}-trigger`;
	const contentId = `${baseId}-content`;
	const contentRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const previousStatus = useRef(status);
	const [contentHeight, setContentHeight] = useState(0);
	const [currentOpen, setOpen] = useControllableOpen({
		open,
		defaultOpen,
		onOpenChange,
	});
	const working = status === "working";
	const expanded = working || currentOpen;
	const contentType = items.length
		? getContentType(items)
		: (initialContentType ?? "mixed");
	const cappedHeight = Math.min(contentHeight, Math.max(0, maxHeight));
	const viewportHeight = working ? Math.max(0, maxHeight) : cappedHeight;
	const capped = contentHeight > maxHeight;
	const streamOffset = working
		? Math.min(0, viewportHeight - contentHeight)
		: 0;

	useLayoutEffect(() => {
		const node = contentRef.current;
		if (!node) {
			return;
		}

		const measure = () => setContentHeight(node.offsetHeight);
		measure();

		if (globalThis.ResizeObserver === undefined) {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (previousStatus.current === "working" && status === "complete") {
			setOpen(!collapseOnComplete);
		}
		previousStatus.current = status;
	}, [collapseOnComplete, setOpen, status]);

	const toggle = () => {
		const next = !currentOpen;
		setOpen(next);
		if (next) {
			requestAnimationFrame(() => viewportRef.current?.scrollTo({ top: 0 }));
		}
	};

	const liveLabel = activeLabel ?? getActiveLabel(contentType);
	const completedSummary = summary ?? getSummary(contentType, items, duration);
	const inline1Style: Inline1Style = {
		"--index-1-height":
			viewportHeight === undefined ? undefined : `${viewportHeight}px`,
	};
	return (
		<div
			aria-busy={working}
			className={cn("w-full text-sm", className)}
			data-content={contentType}
			data-state={working ? "working" : expanded ? "open" : "closed"}
		>
			{working ? (
				<div
					className="flex h-7 min-w-0 items-center gap-2 text-muted-foreground"
					id={triggerId}
					role="status"
				>
					<ActivityIcon type={contentType} />
					<ThinkingShimmer>{liveLabel}</ThinkingShimmer>
				</div>
			) : (
				<button
					aria-controls={contentId}
					aria-expanded={expanded}
					className="group flex h-7 min-w-0 items-center gap-1.5 rounded-md text-left font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					id={triggerId}
					onClick={toggle}
					type="button"
				>
					<ActivityIcon type={contentType} />
					<span className="truncate">{completedSummary}</span>
					<motion.span
						animate={{ rotate: expanded ? 180 : 0 }}
						aria-hidden="true"
						className="inline-flex shrink-0 text-muted-foreground/70 group-hover:text-foreground"
						transition={reduce ? { duration: 0 } : SPRING_SWAP}
					>
						<ChevronDown className="size-3.5" />
					</motion.span>
				</button>
			)}

			<AgentDisclosure
				aria-labelledby={triggerId}
				id={contentId}
				open={expanded}
				openHeight={viewportHeight}
				role="region"
			>
				<div
					className={[
						css.inline1,
						capped && (working ? css.workingMask : css.completedMask),
						cn(
							"scrollbar-hide pr-1",
							capped && expanded && !working
								? "scroll-fade overflow-y-auto"
								: "overflow-y-hidden"
						),
					].join(" ")}
					ref={viewportRef}
					style={inline1Style}
				>
					<motion.div
						animate={{ y: streamOffset }}
						className={cn("space-y-0.5 py-2", contentClassName)}
						initial={false}
						ref={contentRef}
						role="list"
						transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
					>
						<AnimatePresence mode="popLayout">
							{items.map((item) => (
								<motion.div
									animate={{ opacity: 1, y: 0 }}
									exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
									initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
									key={item.id}
									layout="position"
									role="listitem"
									transition={
										reduce
											? { duration: 0 }
											: {
													opacity: { duration: 0.18, ease: EASE_OUT },
													y: SPRING_LAYOUT,
													layout: SPRING_LAYOUT,
												}
									}
								>
									<ActivityRow item={item} />
								</motion.div>
							))}
						</AnimatePresence>
					</motion.div>
				</div>
			</AgentDisclosure>
		</div>
	);
}
