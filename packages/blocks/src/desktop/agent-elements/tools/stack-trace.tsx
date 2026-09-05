import { ToolResult } from "@ryu/ui/components/agents/tool-result";
import { cn } from "@ryu/ui/lib/utils";
import { memo, useMemo } from "react";
import { parseStackTrace, type StackFrame } from "./stack-trace-parse.ts";

export {
	looksLikeStackTrace,
	type ParsedStackTrace,
	parseStackTrace,
	type StackFrame,
} from "./stack-trace-parse.ts";

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

	const header = (
		<div className="flex flex-wrap items-baseline gap-x-2">
			{parsed.errorType ? (
				<span className="font-medium font-mono text-[13px] text-destructive">
					{parsed.errorType}
				</span>
			) : null}
			<span className="min-w-0 break-words text-[13px] text-foreground/90">
				{parsed.errorMessage}
			</span>
		</div>
	);

	return (
		<div
			className={cn(
				"overflow-hidden rounded-2xl border border-destructive/25 bg-destructive/5",
				className
			)}
		>
			<ToolResult
				collapseOnComplete={false}
				copyText={trace}
				defaultOpen={defaultOpen}
				kind="custom"
				status="error"
				title={header}
				tool="stack-trace"
			>
				{frames.length > 0 ? (
					<div className="scroll-fade max-h-[340px] overflow-y-auto">
						{frames.map((frame, index) => (
							<FrameRow
								frame={frame}
								key={`${frame.raw}-${index}`}
								onFilePathClick={onFilePathClick}
							/>
						))}
					</div>
				) : null}
			</ToolResult>
		</div>
	);
});
