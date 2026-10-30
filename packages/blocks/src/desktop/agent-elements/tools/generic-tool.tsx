import { Wrench01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ToolResult } from "@ryu/ui/components/agents/tool-result";
import { cn } from "@ryu/ui/lib/utils";
import type React from "react";
import { memo } from "react";
import { useToolComplete } from "../hooks/use-tool-complete.ts";
import type { StepState, TimelineStep } from "../types/timeline.ts";

export interface GenericToolRowProps {
	onComplete: () => void;
	state: StepState;
	step: Extract<TimelineStep, { type: "tool-call" }>;
}

export function GenericToolRow({
	step,
	state,
	onComplete,
}: GenericToolRowProps) {
	useToolComplete(state === "animating", step.duration, onComplete);
	const isPending = state === "animating";

	return (
		<ToolResult
			defaultOpen={!isPending}
			icon={<HugeiconsIcon className="size-4" icon={Wrench01Icon} />}
			kind="custom"
			status={isPending ? "running" : "success"}
			title={step.toolName}
			tool={step.toolName}
		>
			{step.toolDetail ? (
				<span className="text-muted-foreground text-xs">{step.toolDetail}</span>
			) : null}
		</ToolResult>
	);
}

export interface GenericToolProps {
	icon?: React.ComponentType<{ className?: string }>;
	isError?: boolean;
	isPending: boolean;
	subtitle?: string;
	title: string;
}

export const GenericTool = memo(function GenericTool({
	icon,
	title,
	subtitle,
	isPending,
	isError,
}: GenericToolProps) {
	const Icon = icon;

	return (
		<ToolResult
			defaultOpen={!isPending}
			icon={
				Icon ? (
					<span className="flex size-full shrink-0 text-muted-foreground">
						<Icon className="size-full" />
					</span>
				) : (
					<HugeiconsIcon className="size-4" icon={Wrench01Icon} />
				)
			}
			kind="custom"
			meta={subtitle}
			status={isError ? "error" : isPending ? "running" : "success"}
			title={title}
			tool={title}
		>
			{subtitle ? (
				<span className={cn("text-muted-foreground text-xs")}>{subtitle}</span>
			) : null}
		</ToolResult>
	);
});
