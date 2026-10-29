import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ToolResult,
	ToolResultOutput,
} from "@ryu/ui/components/agents/tool-result";
import { memo } from "react";
import { useToolComplete } from "../hooks/use-tool-complete.ts";
import type { StepState, TimelineStep } from "../types/timeline.ts";
import {
	mapToolInvocationToStep,
	mapToolStateToStepState,
} from "../utils/tool-adapters.ts";
import {
	type ToolApproval,
	ToolApprovalFooter,
} from "./tool-approval-footer.tsx";

function extractCommandSummary(cmd: string): string {
	return cmd
		.split("|")
		.map((s) => s.trim().split(/\s+/)[0] ?? "")
		.filter(Boolean)
		.slice(0, 4)
		.join(", ");
}

export interface BashToolTerminalCardProps {
	approval?: ToolApproval;
	/** When true, command output renders without the height cap. */
	expandOutput?: boolean;
	onComplete: () => void;
	state: StepState;
	step: Extract<TimelineStep, { type: "tool-call" }>;
}

export function BashToolTerminalCard({
	step,
	state,
	onComplete,
	approval,
	expandOutput = false,
}: BashToolTerminalCardProps) {
	const tl = useLiteralMessages();
	useToolComplete(state === "animating", step.duration, onComplete);
	const isPending = state === "animating";
	const command = step.bashCommand ?? step.toolDetail;
	const summary = extractCommandSummary(command);
	const hasOutput = Boolean(step.bashOutput?.trim());

	return (
		<div>
			<ToolResult
				collapseOnComplete={!expandOutput}
				defaultOpen={isPending || hasOutput}
				kind="terminal"
				status={isPending ? "running" : "success"}
				title={
					isPending
						? tl("Running {summary}", { summary })
						: tl("Ran {summary}", { summary })
				}
				tool="Bash"
			>
				<div className="flex flex-col gap-1.5">
					<ToolResultOutput language="bash">{String(command)}</ToolResultOutput>
					{!isPending && hasOutput ? (
						<ToolResultOutput language="bash">
							{String(step.bashOutput)}
						</ToolResultOutput>
					) : null}
				</div>
			</ToolResult>
			{approval && <ToolApprovalFooter isPending={isPending} {...approval} />}
		</div>
	);
}

export interface BashToolProps {
	/** When true, command output renders without the height cap. */
	expandOutput?: boolean;
	part: any;
}

export const BashTool = memo(function BashTool({
	part,
	expandOutput = false,
}: BashToolProps) {
	const approval = part.input?.approval ?? part.args?.approval;
	const step = mapToolInvocationToStep(part.toolCallId ?? part.id ?? "bash", {
		toolName: "Bash",
		args: part.input ?? part.args ?? {},
		state:
			part.state === "output-available"
				? "result"
				: part.state === "input-streaming"
					? "partial-call"
					: "call",
		result: part.output ?? part.result,
	});
	const stepState = mapToolStateToStepState(
		part.state === "output-available"
			? "result"
			: part.state === "input-streaming"
				? "partial-call"
				: "call"
	);
	const noop = () => {};

	return (
		<BashToolTerminalCard
			approval={approval}
			expandOutput={expandOutput}
			onComplete={noop}
			state={stepState}
			step={step}
		/>
	);
});
