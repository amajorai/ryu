import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AgentActivity,
	type AgentActivityTrace,
} from "@ryu/ui/components/agents/agent-activity";
import { memo, useMemo } from "react";
import {
	isCommandToolType,
	isFileEditToolType,
	type ToolActivityPart,
} from "./tool-grouping.ts";
import { toolRegistry } from "./tool-registry.ts";

export interface ToolGroupProps {
	chatStatus?: string;
	parts: ToolActivityPart[];
}

function traceKindForTool(type: string): AgentActivityTrace["kind"] {
	if (isFileEditToolType(type)) {
		return "write";
	}
	if (isCommandToolType(type)) {
		return "run";
	}
	if (type === "tool-Read") {
		return "read";
	}
	return "message";
}

function toTraceItem(
	part: ToolActivityPart,
	index: number
): AgentActivityTrace {
	const meta = toolRegistry[part.type];
	const Icon = meta?.icon;
	return {
		detail: meta?.subtitle?.(part),
		icon: Icon ? <Icon className="size-4" /> : undefined,
		id: part.toolCallId ?? `${part.type}-${index}`,
		kind: traceKindForTool(part.type),
		label: meta?.title(part) ?? part.type.replace("tool-", ""),
		type: "trace",
	};
}

export const ToolGroup = memo(function ToolGroup({
	parts,
	chatStatus,
}: ToolGroupProps) {
	const tl = useLiteralMessages();
	const items = useMemo(
		() => parts.map((part, index) => toTraceItem(part, index)),
		[parts]
	);
	const isWorking =
		chatStatus === "streaming" &&
		parts.some(
			(part) =>
				part.state !== "output-available" && part.state !== "output-error"
		);
	const count = parts.length;

	return (
		<AgentActivity
			activeLabel="Running tools…"
			collapseOnComplete
			contentType="trace"
			items={items}
			status={isWorking ? "working" : "complete"}
			summary={tl("Ran {count, plural, one {# tool} other {# tools}}", {
				count,
			})}
		/>
	);
});
