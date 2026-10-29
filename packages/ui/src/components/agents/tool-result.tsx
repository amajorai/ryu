"use client";
import type { CSSProperties } from "react";
import css from "./tool-result.module.css";

interface Inline1Style extends CSSProperties {
	"--tool-result-1-max-height"?: CSSProperties["maxHeight"];
}

import {
	isNativeFunction,
	isNativeText,
} from "../../lib/native-primitive-observation.ts";

// beui.dev/components/agents/tool-result

import {
	AgentCode,
	type AgentCodeLanguage,
} from "@ryu/ui/components/agents/agent-code.tsx";
import { AgentDisclosure } from "@ryu/ui/components/agents/agent-disclosure.tsx";
import { ActionSwapRollText } from "@ryu/ui/components/motion/action-swap-roll.tsx";
import { SPRING_PRESS, SPRING_SWAP } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Ban,
	BookOpen,
	Braces,
	Check,
	ChevronDown,
	CircleCheck,
	CircleX,
	Copy,
	Globe2,
	LoaderCircle,
	Pencil,
	RotateCcw,
	SquareTerminal,
	Wrench,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { isNativeNumber } from "../../lib/native-primitive-observation.ts";

export type ToolResultStatus = "running" | "success" | "error" | "cancelled";
export type ToolResultKind = "terminal" | "request" | "custom";

export interface ToolResultProps {
	children: ReactNode;
	className?: string;
	collapseOnComplete?: boolean;
	contentClassName?: string;
	copyText?: string;
	defaultOpen?: boolean;
	icon?: ReactNode;
	kind?: ToolResultKind;
	maxHeight?: number;
	meta?: ReactNode;
	onCopy?: () => void | Promise<void>;
	onOpenChange?: (open: boolean) => void;
	onRetry?: () => void;
	open?: boolean;
	status?: ToolResultStatus;
	title: ReactNode;
	tool: ReactNode;
}

export interface ToolResultOutputProps {
	children: string;
	className?: string;
	language?: AgentCodeLanguage;
}

function getStatusLabel(status: ToolResultStatus) {
	if (status === "running") {
		return "Running";
	}
	if (status === "success") {
		return "Completed";
	}
	if (status === "error") {
		return "Failed";
	}
	return "Cancelled";
}

function getSwapKey(value: ReactNode, fallback: string) {
	return isNativeText(value) || isNativeNumber(value)
		? String(value)
		: fallback;
}

function getStatusClass(status: ToolResultStatus) {
	if (status === "running") {
		return "text-status-info";
	}
	if (status === "success") {
		return "text-status-success";
	}
	if (status === "error") {
		return "text-status-destructive";
	}
	return "text-muted-foreground";
}

function KindIcon({ kind, tool }: { kind: ToolResultKind; tool: ReactNode }) {
	const toolName = isNativeText(tool) ? tool.toLowerCase() : "";
	if (toolName.includes("read")) {
		return <BookOpen className="size-4" />;
	}
	if (
		toolName.includes("write") ||
		toolName.includes("edit") ||
		toolName.includes("patch")
	) {
		return <Pencil className="size-4" />;
	}
	if (
		toolName.includes("web") ||
		toolName.includes("search") ||
		toolName.includes("fetch")
	) {
		return <Globe2 className="size-4" />;
	}
	if (kind === "terminal") {
		return <SquareTerminal className="size-4" />;
	}
	if (kind === "request" && toolName.includes("json")) {
		return <Braces className="size-4" />;
	}
	return <Wrench className="size-4" />;
}

function StatusIcon({
	status,
	reduce,
}: {
	status: ToolResultStatus;
	reduce: boolean;
}) {
	if (status === "running") {
		return <LoaderCircle className={cn("size-3", !reduce && "animate-spin")} />;
	}
	if (status === "success") {
		return <CircleCheck className="size-3" />;
	}
	if (status === "error") {
		return <CircleX className="size-3" />;
	}
	return <Ban className="size-3" />;
}

function ToolResultAction({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: ReactNode;
}) {
	const reduce = useReducedMotion() ?? false;

	return (
		<motion.button
			aria-label={label}
			className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onClick}
			title={label}
			transition={SPRING_PRESS}
			type="button"
			whileTap={reduce ? undefined : { scale: 0.9 }}
		>
			{children}
		</motion.button>
	);
}

export function ToolResultOutput({
	children,
	language = "bash",
	className,
}: ToolResultOutputProps) {
	return (
		<AgentCode
			className={cn(
				"whitespace-pre-wrap break-words text-foreground/80",
				className
			)}
			code={children}
			language={language}
		/>
	);
}

export function ToolResult({
	tool,
	title,
	children,
	status = "running",
	kind = "custom",
	meta,
	icon,
	open,
	defaultOpen = true,
	onOpenChange,
	collapseOnComplete = true,
	maxHeight = 220,
	copyText,
	onCopy,
	onRetry,
	className,
	contentClassName,
}: ToolResultProps) {
	const reduce = useReducedMotion() ?? false;
	const baseId = useId();
	const triggerId = `${baseId}-trigger`;
	const contentId = `${baseId}-content`;
	const viewportRef = useRef<HTMLDivElement>(null);
	const previousStatus = useRef(status);
	const copyTimer = useRef<number | undefined>(undefined);
	const [copied, setCopied] = useState(false);
	const [internalOpen, setInternalOpen] = useState(defaultOpen);
	const currentOpen = open ?? internalOpen;
	const running = status === "running";
	const canCopy = Boolean(copyText || onCopy);
	const titleKey = getSwapKey(title, status);
	const metaKey = getSwapKey(meta, `${status}-meta`);
	const toolKey = getSwapKey(tool, `${status}-tool`);
	const statusLabel = getStatusLabel(status);

	const setOpen = useCallback(
		(next: boolean) => {
			if (open === undefined) {
				setInternalOpen(next);
			}
			onOpenChange?.(next);
		},
		[onOpenChange, open]
	);

	useEffect(() => {
		if (previousStatus.current !== "running" && status === "running") {
			setOpen(true);
		}
		if (
			previousStatus.current === "running" &&
			status !== "running" &&
			collapseOnComplete
		) {
			setOpen(false);
		}
		previousStatus.current = status;
	}, [collapseOnComplete, setOpen, status]);

	useEffect(
		() => () => {
			if (copyTimer.current) {
				window.clearTimeout(copyTimer.current);
			}
		},
		[]
	);

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!(viewport && currentOpen && running)) {
			return;
		}

		const frame = requestAnimationFrame(() => {
			if (isNativeFunction(viewport.scrollTo)) {
				viewport.scrollTo({
					top: viewport.scrollHeight,
					behavior: reduce ? "auto" : "smooth",
				});
			} else {
				viewport.scrollTop = viewport.scrollHeight;
			}
		});
		return () => cancelAnimationFrame(frame);
	});

	const handleCopy = useCallback(async () => {
		if (onCopy) {
			await onCopy();
		} else if (copyText) {
			await navigator.clipboard?.writeText(copyText);
		}

		setCopied(true);
		if (copyTimer.current) {
			window.clearTimeout(copyTimer.current);
		}
		copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
	}, [copyText, onCopy]);

	const inline1Style: Inline1Style = {
		"--tool-result-1-max-height":
			maxHeight === undefined ? undefined : `${maxHeight}px`,
	};
	return (
		<div
			aria-busy={running}
			className={cn("w-full text-sm", className)}
			data-state={status}
		>
			<button
				aria-controls={contentId}
				aria-expanded={currentOpen}
				className="group flex min-h-9 w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				id={triggerId}
				onClick={() => setOpen(!currentOpen)}
				type="button"
			>
				<span
					aria-hidden="true"
					className="grid size-4 shrink-0 place-items-center text-muted-foreground"
				>
					{icon ?? <KindIcon kind={kind} tool={tool} />}
				</span>
				<span className="flex min-w-0 flex-1 items-baseline gap-2">
					<span className="min-w-0 truncate font-medium text-foreground/90">
						<ActionSwapRollText value={titleKey}>{title}</ActionSwapRollText>
					</span>
					{meta ? (
						<span className="shrink-0 text-muted-foreground/60 text-xs">
							<ActionSwapRollText value={metaKey}>{meta}</ActionSwapRollText>
						</span>
					) : null}
					<span className="type-caption min-w-0 truncate font-mono text-muted-foreground/55">
						<ActionSwapRollText value={toolKey}>{tool}</ActionSwapRollText>
					</span>
				</span>
				<span
					className={cn(
						"type-caption inline-flex shrink-0 items-center gap-1 font-medium",
						getStatusClass(status)
					)}
				>
					<StatusIcon reduce={reduce} status={status} />
					<ActionSwapRollText value={status}>{statusLabel}</ActionSwapRollText>
				</span>
				<motion.span
					animate={{ rotate: currentOpen ? 180 : 0 }}
					aria-hidden="true"
					className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
					transition={reduce ? { duration: 0 } : SPRING_SWAP}
				>
					<ChevronDown className="size-3.5" />
				</motion.span>
			</button>

			<AgentDisclosure
				aria-labelledby={triggerId}
				id={contentId}
				open={currentOpen}
				role="region"
			>
				<div className="pt-1.5 pl-6">
					<div className="overflow-hidden rounded-xl bg-muted/80">
						<div
							aria-live="polite"
							className={[
								css.inline1,
								"scroll-fade scrollbar-hide overflow-y-auto",
							].join(" ")}
							ref={viewportRef}
							role="log"
							style={inline1Style}
						>
							<div className={cn("p-3", contentClassName)}>{children}</div>
						</div>

						{canCopy || onRetry ? (
							<div className="flex items-center gap-0.5 px-2 pb-1.5">
								{canCopy ? (
									<ToolResultAction
										label={copied ? "Copied" : "Copy result"}
										onClick={handleCopy}
									>
										{copied ? (
											<Check className="size-3.5" />
										) : (
											<Copy className="size-3.5" />
										)}
									</ToolResultAction>
								) : null}
								{onRetry ? (
									<ToolResultAction label="Run again" onClick={onRetry}>
										<RotateCcw className="size-3.5" />
									</ToolResultAction>
								) : null}
								<span className="type-caption ml-auto text-muted-foreground/55">
									<ActionSwapRollText value={status}>
										{statusLabel}
									</ActionSwapRollText>
								</span>
							</div>
						) : null}
					</div>
				</div>
			</AgentDisclosure>
		</div>
	);
}
