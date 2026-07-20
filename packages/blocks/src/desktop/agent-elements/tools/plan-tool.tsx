import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconChevronsDown,
	IconChevronsUp,
	IconFileDescription,
} from "@tabler/icons-react";
import { memo, useState } from "react";
import { IconSpinner } from "../icons.tsx";
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
	const [isExpanded, setIsExpanded] = useState(false);
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
		if (typeof part.input?.onApprove === "function") {
			part.input.onApprove();
		}
	};

	return (
		<div className="an-tool-plan overflow-hidden rounded-[var(--radius)] bg-muted">
			<div className="flex h-7 items-center justify-between pr-2.5 pl-3">
				<div className="flex min-w-0 items-center gap-1">
					{isPending ? (
						<IconSpinner className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
					) : (
						<IconFileDescription className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					)}
					<span className="truncate text-muted-foreground text-xs">
						{fileName}
					</span>
				</div>
				<Button
					aria-label={isExpanded ? "Collapse plan" : "Expand plan"}
					className="size-5 text-muted-foreground"
					onClick={() => setIsExpanded((prev) => !prev)}
					size="icon"
					type="button"
					variant="ghost"
				>
					{isExpanded ? (
						<IconChevronsUp className="h-3.5 w-3.5" />
					) : (
						<IconChevronsDown className="h-3.5 w-3.5" />
					)}
				</Button>
			</div>

			<div className="pt-2">
				<div className="space-y-1.5">
					<div className="px-3 text-foreground text-sm">{plan.title}</div>

					{hasSummary ? (
						<div className="relative">
							<div
								className={cn(
									"px-3",
									"text-muted-foreground text-sm",
									!isExpanded && "max-h-[94px] overflow-hidden"
								)}
							>
								<Markdown className="text-sm" content={summary} />
							</div>

							{!isExpanded && (
								<div className="absolute inset-x-0 bottom-0 h-16 pr-2 pb-2 pl-3.5">
									<div className="absolute inset-x-0 bottom-0 h-full w-full bg-linear-to-b from-0% from-transparent to-50% to-background" />
									<div className="relative flex h-full items-end justify-between">
										<Button
											className="-mx-2 h-5 px-1.5 text-muted-foreground text-xs hover:text-foreground"
											onClick={() => setIsExpanded(true)}
											size="sm"
											type="button"
											variant="ghost"
										>
											Read detailed plan
										</Button>
										{!isAlreadyApproved && (
											<Button
												className="h-5 px-1.5 text-xs"
												onClick={handleApprove}
												size="sm"
												type="button"
											>
												{approveText}
											</Button>
										)}
									</div>
								</div>
							)}
						</div>
					) : (
						<div className="text-muted-foreground text-xs">
							No plan summary provided.
						</div>
					)}
				</div>

				{(isExpanded || !hasSummary) && (
					<div className="mt-2 flex items-center justify-between pt-1.5 pr-2 pb-2 pl-3.5">
						<Button
							className="-mx-2 h-5 px-1.5 text-muted-foreground text-xs hover:text-foreground"
							onClick={() => setIsExpanded((prev) => !prev)}
							size="sm"
							type="button"
							variant="ghost"
						>
							{isExpanded ? "Hide detailed plan" : "Read detailed plan"}
						</Button>
						{!isAlreadyApproved && (
							<Button
								className="h-5 px-1.5 text-xs"
								onClick={handleApprove}
								size="sm"
								type="button"
							>
								{approveText}
							</Button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}, areToolPropsEqual);
