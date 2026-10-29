import { AgentActivity } from "@ryu/ui/components/agents/agent-activity";
import { memo, useEffect, useMemo, useState } from "react";
import { getToolStatus } from "../utils/format-tool.ts";
import { toolRegistry } from "./tool-registry.ts";

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

/** Map a nested ACP tool part onto a beUI AgentActivity trace item. */
function toTraceItem(part: any, index: number) {
	const meta = toolRegistry[part.type];
	const label = meta?.title(part) ?? part.type?.replace("tool-", "") ?? "Tool";
	const detail = meta?.subtitle?.(part);
	return {
		id: part.toolCallId ?? `${part.type}-${index}`,
		type: "trace" as const,
		kind: "message" as const,
		label,
		detail,
	};
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
		part.callProviderMetadata?.custom?.startedAt ?? part.startedAt;
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
				const sub = meta.subtitle?.(lastTool);
				return sub ? `${title} ${sub}` : title;
			}
		}

		if (!description) {
			return "";
		}
		return description.length > 60
			? `${description.slice(0, 57)}…`
			: description;
	})();
	const elapsedTimeDisplay = formatElapsedTime(
		!isPending && outputDuration ? outputDuration : elapsedMs
	);

	const items = useMemo(
		() =>
			nestedTools
				.slice(0, MAX_VISIBLE_TOOLS)
				.map((nestedPart, idx) => toTraceItem(nestedPart, idx)),
		[nestedTools]
	);

	if (isInterrupted && !part.output) {
		return (
			<span className="text-muted-foreground text-sm">
				Subagent interrupted
			</span>
		);
	}

	return (
		<div>
			<AgentActivity
				activeLabel={
					elapsedTimeDisplay
						? `${subtitle || "Running subagent"} · ${elapsedTimeDisplay}`
						: subtitle || "Running subagent"
				}
				collapseOnComplete={false}
				contentType="trace"
				defaultOpen={false}
				items={items}
				status={isPending ? "working" : "complete"}
				summary={
					description.length > 60
						? `${description.slice(0, 57)}…`
						: description || "Subagent completed"
				}
			/>
		</div>
	);
});
