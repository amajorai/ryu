"use client";

// beui.dev/components/agents/code-block

import type { CSSProperties } from "react";
import css from "./code-block.module.css";

interface Inline1Style extends CSSProperties {
	"--code-block-1-max-height"?: CSSProperties["maxHeight"];
}

import {
	type AgentCodeLanguage,
	AgentCodeLine,
	useAgentCodeTokens,
} from "@ryu/ui/components/agents/agent-code.tsx";
import { SPRING_PRESS } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Check, Copy, FileCode2, LoaderCircle } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

export type CodeBlockStatus = "streaming" | "complete";

export interface CodeBlockProps {
	className?: string;
	code: string;
	copyable?: boolean;
	filename?: ReactNode;
	highlightLines?: number[];
	language?: AgentCodeLanguage;
	maxHeight?: number;
	onCopy?: () => Promise<void> | void;
	showLineNumbers?: boolean;
	status?: CodeBlockStatus;
	wrap?: boolean;
}

const COPIED_RESET_MS = 1600;
const EMPTY_HIGHLIGHT: number[] = [];

export function CodeBlock({
	code,
	language = "typescript",
	filename,
	status = "complete",
	showLineNumbers = true,
	highlightLines = EMPTY_HIGHLIGHT,
	maxHeight = 280,
	wrap = false,
	copyable = true,
	onCopy,
	className,
}: CodeBlockProps) {
	const reduce = useReducedMotion() ?? false;
	const viewportRef = useRef<HTMLDivElement>(null);
	const copyTimer = useRef<number | undefined>(undefined);
	const [copied, setCopied] = useState(false);
	const streaming = status === "streaming";
	const tokens = useAgentCodeTokens(code, language);
	const highlighted = useMemo(() => new Set(highlightLines), [highlightLines]);
	let offset = 0;
	const lines = code.split("\n").map((content) => {
		const line = { content, offset };
		offset += content.length + 1;
		return line;
	});

	useEffect(
		() => () => {
			if (copyTimer.current) {
				window.clearTimeout(copyTimer.current);
			}
		},
		[]
	);

	// Follow the tail while the agent is still writing. Deliberately runs on
	// every render (no dep array): the trigger is new content, and `code` is a
	// fresh string on each streamed chunk.
	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!(viewport && streaming)) {
			return;
		}
		const frame = requestAnimationFrame(() => {
			if (viewport.scrollHeight <= viewport.clientHeight) {
				return;
			}
			viewport.scrollTo({
				top: viewport.scrollHeight,
				behavior: reduce ? "auto" : "smooth",
			});
		});
		return () => cancelAnimationFrame(frame);
	});

	const handleCopy = useCallback(async () => {
		if (onCopy) {
			await onCopy();
		} else {
			await navigator.clipboard?.writeText(code);
		}
		setCopied(true);
		if (copyTimer.current) {
			window.clearTimeout(copyTimer.current);
		}
		copyTimer.current = window.setTimeout(
			() => setCopied(false),
			COPIED_RESET_MS
		);
	}, [code, onCopy]);

	const inline1Style: Inline1Style = {
		"--code-block-1-max-height":
			maxHeight === undefined ? undefined : `${maxHeight}px`,
	};
	return (
		<div
			aria-busy={streaming}
			className={cn(
				"w-full overflow-hidden rounded-2xl bg-muted/80 text-sm",
				className
			)}
			data-state={status}
		>
			<div className="flex h-10 items-center gap-2.5 px-3">
				<FileCode2
					aria-hidden="true"
					className="size-3.5 shrink-0 text-muted-foreground/70"
				/>
				{filename ? (
					<span className="min-w-0 truncate font-mono text-foreground/80 text-xs">
						{filename}
					</span>
				) : null}
				<span className="type-compact font-medium text-muted-foreground/55 uppercase tracking-wide">
					{language}
				</span>
				<span
					className={cn(
						"type-compact ml-auto inline-flex shrink-0 items-center gap-1 font-medium",
						streaming ? "text-status-info" : "text-status-success"
					)}
				>
					{streaming ? (
						<LoaderCircle className={cn("size-3", !reduce && "animate-spin")} />
					) : (
						<Check className="size-3" />
					)}
					{streaming ? "Writing" : "Ready"}
				</span>
				{copyable || onCopy ? (
					<motion.button
						aria-label={copied ? "Copied" : "Copy code"}
						className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						onClick={handleCopy}
						title={copied ? "Copied" : "Copy code"}
						transition={SPRING_PRESS}
						type="button"
						whileTap={reduce ? undefined : { scale: 0.9 }}
					>
						{copied ? (
							<Check className="size-3.5" />
						) : (
							<Copy className="size-3.5" />
						)}
					</motion.button>
				) : null}
			</div>

			<div
				aria-live={streaming ? "polite" : undefined}
				className={[
					css.inline1,
					"scrollbar-hide overflow-auto border-foreground/[0.06] border-t py-2",
				].join(" ")}
				ref={viewportRef}
				role={streaming ? "log" : undefined}
				style={inline1Style}
			>
				<pre className="m-0 min-w-max font-mono text-foreground/85 text-xs leading-5">
					<code>
						{lines.map((line, index) => {
							const lineNumber = index + 1;
							return (
								<span
									className={cn(
										"grid min-h-5",
										showLineNumbers
											? "grid-cols-[2.75rem_minmax(0,1fr)]"
											: "grid-cols-1",
										highlighted.has(lineNumber) && "bg-info/[0.07]"
									)}
									key={line.offset}
								>
									{showLineNumbers ? (
										<span className="select-none pr-3 text-right text-muted-foreground/35 tabular-nums">
											{lineNumber}
										</span>
									) : null}
									<AgentCodeLine
										className={cn(
											"pr-4",
											showLineNumbers ? "pl-1" : "pl-4",
											wrap
												? "whitespace-pre-wrap break-words"
												: "whitespace-pre"
										)}
										code={line.content}
										tokens={tokens?.[index]}
									/>
								</span>
							);
						})}
					</code>
				</pre>
			</div>
		</div>
	);
}
