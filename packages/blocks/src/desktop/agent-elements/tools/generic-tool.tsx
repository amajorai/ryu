import type React from "react";
import { memo } from "react";
import { useToolComplete } from "../hooks/use-tool-complete.ts";
import type { StepState, TimelineStep } from "../types/timeline.ts";
import { ToolRowBase } from "./tool-row-base.tsx";

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
		<ToolRowBase
			completeLabel={step.toolName}
			detail={step.toolDetail}
			isAnimating={isPending}
			shimmerLabel={step.toolName}
		/>
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
}: GenericToolProps) {
	const Icon = icon;

	return (
		<ToolRowBase
			completeLabel={title}
			detail={subtitle}
			icon={
				Icon ? (
					<Icon className="h-full w-full shrink-0 text-muted-foreground" />
				) : undefined
			}
			isAnimating={isPending}
			shimmerLabel={title}
		/>
	);
});
