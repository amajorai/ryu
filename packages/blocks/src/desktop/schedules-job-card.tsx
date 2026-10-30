"use client";

import {
	CancelCircleIcon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	Delete01Icon,
	WorkflowCircle06Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { RunStatusTimeline } from "@ryu/ui/components/run-status-timeline";
import type { ScheduleOutcome, ScheduleRow } from "./schedules-types.ts";

function OutcomeBadge({ outcome }: { outcome: ScheduleOutcome }) {
	if (outcome === "success") {
		return (
			<Badge variant="secondary">
				<HugeiconsIcon
					className="size-3 text-status-success"
					icon={CheckmarkCircle02Icon}
				/>
				Succeeded
			</Badge>
		);
	}
	return (
		<Badge variant="destructive">
			<HugeiconsIcon className="size-3" icon={CancelCircleIcon} />
			Failed
		</Badge>
	);
}

export function JobCard({
	job,
	onDelete,
	timelineEndAt,
}: {
	job: ScheduleRow;
	onDelete?: (id: string) => void;
	timelineEndAt?: number;
}) {
	const tl = useLiteralMessages();
	const endAt = timelineEndAt ?? Date.now();
	const startAt = endAt - 24 * 60 * 60 * 1000;
	const runs = job.recentRuns ?? [];
	const runCount = runs.length;
	const runWord = runCount === 1 ? "run" : "runs";

	return (
		<Card>
			<CardHeader>
				<CardTitle layout="badge-row">
					<HugeiconsIcon className="size-4 opacity-70" icon={ZapIcon} />
					{job.name}
				</CardTitle>
				<CardDescription className="flex-wrap" layout="legend">
					<Badge variant="secondary">
						<HugeiconsIcon className="size-3" icon={Clock01Icon} />
						{job.scheduleLabel}
					</Badge>
					{job.agentId ? (
						<Badge variant="secondary">{job.agentId}</Badge>
					) : (
						<Badge variant="secondary">
							<HugeiconsIcon className="size-3" icon={WorkflowCircle06Icon} />
							{job.workflowName ?? "Workflow"}
						</Badge>
					)}
					{job.enabled ? null : <Badge variant="secondary">disabled</Badge>}
				</CardDescription>
			</CardHeader>
			<CardContent layout="stack">
				<div className="flex items-center gap-2 text-sm">
					{job.lastOutcome ? <OutcomeBadge outcome={job.lastOutcome} /> : null}
					<span className="text-muted-foreground">
						{tl("Last run: {lastRunLabel}", { lastRunLabel: job.lastRunLabel })}
					</span>
				</div>
				<div className="border-t pt-3">
					<div className="mb-1.5 flex items-center justify-between gap-2">
						<span className="font-medium text-muted-foreground text-xs">
							Last 24 hours
						</span>
						<span className="text-muted-foreground text-xs tabular-nums">
							{runCount} {runWord}
						</span>
					</div>
					<RunStatusTimeline
						ariaLabel={tl("{name} run status in the last 24 hours", {
							name: job.name,
						})}
						endAt={endAt}
						entries={runs}
						showScale
						startAt={startAt}
					/>
				</div>
				{job.lastOutcome === "failure" && job.lastError ? (
					<p className="line-clamp-2 text-status-destructive text-xs">
						{job.lastError}
					</p>
				) : null}
				<Button
					className="self-start"
					onClick={() => onDelete?.(job.id)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Delete01Icon} />
					Delete
				</Button>
			</CardContent>
		</Card>
	);
}
