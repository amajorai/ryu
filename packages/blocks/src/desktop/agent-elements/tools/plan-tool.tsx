import { ToolResult } from "@ryu/ui/components/agents/tool-result";
import { Button } from "@ryu/ui/components/button";
import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import { memo, useState } from "react";
import { Markdown } from "../markdown.tsx";
import { areToolPropsEqual, getToolStatus } from "../utils/format-tool.ts";

export interface Plan {
	id?: string;
	summary?: string;
	title: string;
}

export interface PlanToolProps {
	chatStatus?: string;
	part: {
		type: string;
		toolCallId?: string;
		state?: string;
		input?: {
			plan?: Plan;
			onApprove?: () => void;
			approveLabel?: string;
			approved?: boolean;
		};
	};
}

function getPlanFileName(plan: Plan) {
	const rawId = plan.id?.trim();
	if (!rawId) {
		return "plan-working.md";
	}
	if (rawId.endsWith(".md")) {
		return rawId;
	}
	return `plan-${rawId}.md`;
}

export const PlanTool = memo(function PlanTool({
	part,
	chatStatus,
}: PlanToolProps) {
	const { isPending } = getToolStatus(part, chatStatus);
	const plan = part.input?.plan;
	const [isApproved, setIsApproved] = useState(false);

	if (!plan) {
		return null;
	}

	const fileName = getPlanFileName(plan);
	const summary = plan.summary?.trim() ?? "";
	const hasSummary = summary.length > 0;

	const approveLabel = part.input?.approveLabel ?? "Approve";
	const isAlreadyApproved = part.input?.approved || isApproved;
	const approveText = isAlreadyApproved ? "Approved" : approveLabel;

	const handleApprove = () => {
		if (isAlreadyApproved) {
			return;
		}
		setIsApproved(true);
		if (isNativeFunction(part.input?.onApprove)) {
			part.input.onApprove();
		}
	};

	return (
		<div>
			<ToolResult
				collapseOnComplete={false}
				defaultOpen={!isPending}
				kind="custom"
				status={isPending ? "running" : "success"}
				title={plan.title}
				tool={fileName}
			>
				<div className="space-y-2">
					{hasSummary ? (
						<Markdown className="text-sm" content={summary} />
					) : (
						<p className="text-muted-foreground text-xs">
							No plan summary provided.
						</p>
					)}
					{isAlreadyApproved ? (
						<p className="text-status-success text-xs">{approveText}</p>
					) : (
						<div className="flex items-center gap-2 border-border/60 border-t pt-2">
							<Button
								appearance="plan-approve"
								disabled={isPending}
								onClick={handleApprove}
								size="sm"
								type="button"
							>
								{approveText}
							</Button>
						</div>
					)}
				</div>
			</ToolResult>
		</div>
	);
}, areToolPropsEqual);
