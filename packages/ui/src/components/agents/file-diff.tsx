"use client";
import {
	ArrowDown01Icon,
	Copy01Icon,
	Loading03Icon,
	SourceCodeIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CSSProperties } from "react";
import css from "./file-diff.module.css";

interface Inline1Style extends CSSProperties {
	"--file-diff-1-max-height"?: CSSProperties["maxHeight"];
}

import { isNativeFunction } from "../../lib/native-primitive-observation.ts";

// beui.dev/components/agents/file-diff

import {
	type AgentCodeLanguage,
	AgentCodeLine,
	useAgentCodeTokens,
} from "@ryu/ui/components/agents/agent-code.tsx";
import { AgentDisclosure } from "@ryu/ui/components/agents/agent-disclosure.tsx";
import { SPRING_PRESS, SPRING_SWAP } from "@ryu/ui/lib/ease.ts";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
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

export type FileDiffStatus = "streaming" | "complete";
export type FileDiffLineType = "added" | "removed" | "context";

export interface FileDiffLine {
	content: string;
	id: string;
	newLine?: number;
	oldLine?: number;
	type?: FileDiffLineType;
}

export interface FileDiffProps {
	className?: string;
	collapseOnComplete?: boolean;
	copyText?: string;
	defaultOpen?: boolean;
	file: ReactNode;
	icon?: ReactNode;
	language?: AgentCodeLanguage;
	lines: FileDiffLine[];
	maxHeight?: number;
	onCopy?: () => void | Promise<void>;
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
	status?: FileDiffStatus;
}

function ChangeCount({
	value,
	type,
}: {
	value: number;
	type: "added" | "removed";
}) {
	if (!value) {
		return null;
	}
	return (
		<span
			className={cn(
				"font-mono text-xs tabular-nums",
				type === "added" ? "text-status-success" : "text-status-destructive"
			)}
		>
			{type === "added" ? "+" : "−"}
			{formatCount(value) ?? "—"}
		</span>
	);
}

export function FileDiff({
	file,
	icon,
	lines,
	status = "streaming",
	open,
	defaultOpen = true,
	onOpenChange,
	collapseOnComplete = true,
	maxHeight = 220,
	language = "typescript",
	copyText,
	onCopy,
	className,
}: FileDiffProps) {
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
	const streaming = status === "streaming";
	const additions = lines.filter((line) => line.type === "added").length;
	const deletions = lines.filter((line) => line.type === "removed").length;
	const canCopy = Boolean(copyText || onCopy);
	const code = lines.map((line) => line.content).join("\n");
	const tokens = useAgentCodeTokens(code, language);

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
		if (previousStatus.current !== "streaming" && status === "streaming") {
			setOpen(true);
		}
		if (
			previousStatus.current === "streaming" &&
			status === "complete" &&
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
		if (!(viewport && currentOpen && streaming)) {
			return;
		}

		const frame = requestAnimationFrame(() => {
			if (viewport.scrollHeight <= viewport.clientHeight) {
				return;
			}
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
		"--file-diff-1-max-height":
			maxHeight === undefined ? undefined : `${maxHeight}px`,
	};
	return (
		<div
			aria-busy={streaming}
			className={cn("w-full text-sm", className)}
			data-state={status}
		>
			<button
				aria-controls={contentId}
				aria-expanded={currentOpen}
				className="group flex min-h-9 w-full items-center gap-2 rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				id={triggerId}
				onClick={() => setOpen(!currentOpen)}
				type="button"
			>
				<span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
					{icon ?? (
						<HugeiconsIcon
							aria-hidden="true"
							className="size-4"
							icon={SourceCodeIcon}
						/>
					)}
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-foreground text-xs">
					{file}
				</span>
				<span className="flex shrink-0 items-center gap-2">
					<ChangeCount type="added" value={additions} />
					<ChangeCount type="removed" value={deletions} />
				</span>
				<span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
					{streaming ? (
						<HugeiconsIcon
							aria-label="Applying changes"
							className={cn("size-3.5", !reduce && "animate-spin")}
							icon={Loading03Icon}
						/>
					) : (
						<HugeiconsIcon
							aria-label="Changes applied"
							className="size-3.5"
							icon={Tick02Icon}
						/>
					)}
				</span>
				<motion.span
					animate={{ rotate: currentOpen ? 180 : 0 }}
					aria-hidden="true"
					className="shrink-0 text-muted-foreground/70 transition-colors group-hover:text-muted-foreground"
					transition={reduce ? { duration: 0 } : SPRING_SWAP}
				>
					<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
				</motion.span>
			</button>

			<AgentDisclosure
				aria-labelledby={triggerId}
				id={contentId}
				open={currentOpen}
				role="region"
			>
				<div className="pt-1.5 pl-6">
					<div className="overflow-hidden rounded-xl bg-muted">
						<div
							aria-live="polite"
							className={[css.inline1, "scrollbar-hide overflow-auto"].join(
								" "
							)}
							data-slot="file-diff-viewport"
							ref={viewportRef}
							style={inline1Style}
						>
							<div className="font-mono text-xs leading-5">
								<span className="sr-only">File changes</span>
								{lines.map((line, index) => {
									const type = line.type ?? "context";
									return (
										<div
											className={cn(
												"grid grid-cols-[2.25rem_2.25rem_1rem_minmax(0,1fr)]",
												type === "added" && "bg-success/[0.07]",
												type === "removed" && "bg-destructive/[0.07]"
											)}
											key={line.id}
										>
											<span className="select-none pr-2 text-right text-muted-foreground/70 tabular-nums">
												{line.oldLine}
											</span>
											<span className="select-none pr-2 text-right text-muted-foreground/70 tabular-nums">
												{line.newLine}
											</span>
											<span
												className={cn(
													"select-none text-center text-muted-foreground/70",
													type === "added" && "text-status-success",
													type === "removed" && "text-status-destructive"
												)}
											>
												{type === "added" ? "+" : type === "removed" ? "−" : ""}
											</span>
											<AgentCodeLine
												className="min-w-0 whitespace-pre px-1.5"
												code={line.content}
												tokens={tokens?.[index]}
											/>
										</div>
									);
								})}
							</div>
						</div>

						{canCopy ? (
							<div className="flex justify-end px-2 pt-1 pb-1.5">
								<motion.button
									aria-label={copied ? "Copied" : "Copy diff"}
									className="grid size-7 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
									onClick={handleCopy}
									title={copied ? "Copied" : "Copy diff"}
									transition={SPRING_PRESS}
									type="button"
									whileTap={reduce ? undefined : { scale: 0.9 }}
								>
									{copied ? (
										<HugeiconsIcon className="size-3.5" icon={Tick02Icon} />
									) : (
										<HugeiconsIcon className="size-3.5" icon={Copy01Icon} />
									)}
								</motion.button>
							</div>
						) : null}
					</div>
				</div>
			</AgentDisclosure>
		</div>
	);
}
