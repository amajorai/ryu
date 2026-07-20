import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible";
import { cn } from "@ryu/ui/lib/utils";
import { IconCheck, IconChevronRight, IconCopy } from "@tabler/icons-react";
import { memo, useMemo, useState } from "react";
import { parseStackTrace, type StackFrame } from "./stack-trace-parse.ts";

export {
	looksLikeStackTrace,
	type ParsedStackTrace,
	parseStackTrace,
	type StackFrame,
} from "./stack-trace-parse.ts";

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			aria-label="Copy stack trace"
			className="flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
			onClick={(event) => {
				event.stopPropagation();
				navigator.clipboard.writeText(text);
				setCopied(true);
				window.setTimeout(() => setCopied(false), 2000);
			}}
			type="button"
		>
			{copied ? (
				<IconCheck className="size-3.5" />
			) : (
				<IconCopy className="size-3.5" />
			)}
		</button>
	);
}

function FrameRow({
	frame,
	onFilePathClick,
}: {
	frame: StackFrame;
	onFilePathClick?: (path: string, line?: number, col?: number) => void;
}) {
	const location =
		frame.line == null
			? frame.file
			: `${frame.file}:${frame.line}${frame.col == null ? "" : `:${frame.col}`}`;
	const canClick = Boolean(onFilePathClick) && Boolean(frame.file);
	return (
		<div
			className={cn(
				"flex flex-wrap items-baseline gap-x-2 py-0.5 font-mono text-[12px] leading-[16px]",
				frame.internal && "opacity-45"
			)}
		>
			<span className="text-muted-foreground">at</span>
			{frame.fn ? <span className="text-foreground">{frame.fn}</span> : null}
			{canClick ? (
				<button
					className="text-primary underline-offset-2 hover:underline"
					onClick={() => onFilePathClick?.(frame.file, frame.line, frame.col)}
					type="button"
				>
					{location}
				</button>
			) : (
				<span className="text-muted-foreground/80">{location}</span>
			)}
		</div>
	);
}

export interface StackTraceProps {
	className?: string;
	defaultOpen?: boolean;
	onFilePathClick?: (path: string, line?: number, col?: number) => void;
	showInternalFrames?: boolean;
	trace: string;
}

export const StackTrace = memo(function StackTrace({
	trace,
	defaultOpen = false,
	onFilePathClick,
	showInternalFrames = true,
	className,
}: StackTraceProps) {
	const parsed = useMemo(() => parseStackTrace(trace), [trace]);
	const frames = useMemo(
		() =>
			showInternalFrames
				? parsed.frames
				: parsed.frames.filter((frame) => !frame.internal),
		[parsed.frames, showInternalFrames]
	);

	return (
		<Collapsible
			className={cn(
				"w-full overflow-hidden rounded-[var(--radius)] border border-destructive/25 bg-destructive/5",
				className
			)}
			defaultOpen={defaultOpen}
		>
			<div className="flex items-start gap-2 px-3 py-2">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-x-2">
						{parsed.errorType ? (
							<span className="font-mono font-semibold text-[13px] text-destructive">
								{parsed.errorType}
							</span>
						) : null}
						<span className="min-w-0 break-words text-[13px] text-foreground/90">
							{parsed.errorMessage}
						</span>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<CopyButton text={trace} />
					{frames.length > 0 ? (
						<CollapsibleTrigger
							aria-label="Toggle stack frames"
							className="group flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
						>
							<IconChevronRight className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-90" />
						</CollapsibleTrigger>
					) : null}
				</div>
			</div>
			{frames.length > 0 ? (
				<CollapsibleContent
					className={cn(
						"overflow-hidden",
						"transition-all duration-150 ease-out",
						"data-ending-style:h-0 data-starting-style:h-0",
						"[&[hidden]:not([hidden='until-found'])]:hidden"
					)}
				>
					<div className="max-h-[340px] overflow-y-auto border-destructive/15 border-t px-3 py-2">
						{frames.map((frame, index) => (
							<FrameRow
								frame={frame}
								key={`${frame.raw}-${index}`}
								onFilePathClick={onFilePathClick}
							/>
						))}
					</div>
				</CollapsibleContent>
			) : null}
		</Collapsible>
	);
});
