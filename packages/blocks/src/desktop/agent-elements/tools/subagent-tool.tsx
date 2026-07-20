import { cn } from "@ryu/ui/lib/utils";
import { memo, useEffect, useState } from "react";
import { getToolStatus } from "../utils/format-tool.ts";
import { GenericTool } from "./generic-tool.tsx";
import { toolRegistry } from "./tool-registry.ts";
import { ToolRowBase } from "./tool-row-base.tsx";

export interface SubagentToolProps {
	chatStatus?: string;
	nestedTools?: any[];
	part: any;
}

const MAX_VISIBLE_TOOLS = 5;

function formatElapsedTime(ms: number): string {
	if (ms < 1000) {
		return "";
	}
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (remainingSeconds === 0) {
		return `${minutes}m`;
	}
	return `${minutes}m ${remainingSeconds}s`;
}

export const SubagentTool = memo(function SubagentTool({
	part,
	nestedTools = [],
	chatStatus,
}: SubagentToolProps) {
	const { isPending, isInterrupted } = getToolStatus(part, chatStatus);
	const description = part.input?.description || "";
	const [elapsedMs, setElapsedMs] = useState(0);
	const startedAt =
		(part.callProviderMetadata?.custom?.startedAt as number | undefined) ??
		(part.startedAt as number | undefined);
	const hasNestedTools = nestedTools.length > 0;
	const outputDuration =
		part.output?.totalDurationMs ||
		part.output?.duration ||
		part.output?.duration_ms;

	useEffect(() => {
		if (isPending && startedAt) {
			setElapsedMs(Date.now() - startedAt);
			const interval = setInterval(() => {
				setElapsedMs(Date.now() - startedAt);
			}, 1000);
			return () => clearInterval(interval);
		}
	}, [isPending, startedAt]);

	const subtitle = (() => {
		if (isPending && hasNestedTools) {
			const lastTool = nestedTools.at(-1);
			const meta = lastTool ? toolRegistry[lastTool.type] : null;
			if (meta) {
				const title = meta.title(lastTool);
				const subtitle = meta.subtitle?.(lastTool);
				return subtitle ? `${title} ${subtitle}` : title;
			}
		}

		if (!description) {
			return "";
		}
		return description.length > 60
			? `${description.slice(0, 57)}...`
			: description;
	})();
	const elapsedTimeDisplay = formatElapsedTime(
		!isPending && outputDuration ? outputDuration : elapsedMs
	);

	if (isInterrupted && !part.output) {
		return (
			<ToolRowBase completeLabel="Subagent interrupted" isAnimating={false} />
		);
	}

	return (
		<div className="an-tool-task">
			<ToolRowBase
				completeLabel="Completed Subagent"
				detail={subtitle}
				expandable={hasNestedTools}
				isAnimating={isPending}
				shimmerLabel="Running Subagent"
				trailingContent={
					elapsedTimeDisplay ? (
						<span className="shrink-0 font-normal text-muted-foreground/60 tabular-nums">
							{elapsedTimeDisplay}
						</span>
					) : undefined
				}
			>
				<div className="relative">
					{isPending && nestedTools.length > MAX_VISIBLE_TOOLS && (
						<div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-linear-to-b from-background to-transparent" />
					)}
					<div
						className={cn(
							nestedTools.length > 1 ? "space-y-2" : "space-y-0",
							isPending &&
								nestedTools.length > MAX_VISIBLE_TOOLS &&
								"max-h-[120px] overflow-y-auto"
						)}
					>
						{nestedTools.map((nestedPart, idx) => {
							const nestedMeta = toolRegistry[nestedPart.type];
							if (!nestedMeta) {
								return (
									<ToolRowBase
										completeLabel={
											nestedPart.type?.replace("tool-", "") ?? "Tool"
										}
										isAnimating={false}
										key={idx}
									/>
								);
							}
							const { isPending: nestedIsPending, isError: nestedIsError } =
								getToolStatus(nestedPart, chatStatus);
							return (
								<GenericTool
									icon={nestedMeta.icon}
									isError={nestedIsError}
									isPending={nestedIsPending}
									key={idx}
									subtitle={nestedMeta.subtitle?.(nestedPart)}
									title={nestedMeta.title(nestedPart)}
								/>
							);
						})}
					</div>
				</div>
			</ToolRowBase>
		</div>
	);
});
