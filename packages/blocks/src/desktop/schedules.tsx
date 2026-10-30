"use client";

// Presentational layer of the desktop Automations / Schedules page. The live app
// (`apps/desktop/src/pages/SchedulesPage.tsx`) is a thin container that loads
// jobs/agents/workflows via hooks and renders this view with real handlers; the
// storyboard renders the same component with mock data and no-op handlers. One
// source of truth, so editing this block changes the real desktop too.
//
// The container pre-formats the human-readable schedule label, last-run string,
// and target badge for each job (so this layer needs neither date-fns nor the
// schedules-api cron helpers). The only local state here is the create-dialog
// form — plain UI state, not app/backend/Tauri state.

import { Clock01Icon, ZapIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import {
	RunStatusTimeline,
	RunStatusTimelineLegend,
} from "@ryu/ui/components/run-status-timeline";
import { Spinner } from "@ryu/ui/components/spinner";
import { CreateAutomationDialog } from "./schedules-create-dialog.tsx";
import { JobCard } from "./schedules-job-card.tsx";
import type { SchedulesViewProps } from "./schedules-types.ts";

export type {
	AgentOption,
	CreateSchedulePayload,
	ScheduleKind,
	ScheduleOutcome,
	ScheduleRow,
	ScheduleRun,
	SchedulesViewProps,
	TargetKind,
	WorkflowOption,
} from "./schedules-types.ts";

export function SchedulesView<Result>({
	loading,
	error,
	jobs,
	agents,
	agentsLoading,
	workflows,
	workflowsLoading,
	onCreate,
	onDelete,
	onRetry,
	timelineEndAt,
}: SchedulesViewProps<Result>) {
	const tl = useLiteralMessages();
	if (loading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Clock01Icon} />
					</EmptyMedia>
					<EmptyTitle>Could not load automations</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				{onRetry ? (
					<EmptyContent>
						<Button onClick={onRetry} size="sm" variant="ghost">
							Try again
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}

	const createDialog = (
		<CreateAutomationDialog
			agents={agents}
			agentsLoading={agentsLoading}
			onCreate={onCreate}
			workflows={workflows}
			workflowsLoading={workflowsLoading}
		/>
	);
	const statusRuns = jobs.flatMap((job) => job.recentRuns ?? []);
	const statusEndAt = timelineEndAt ?? Date.now();
	const statusStartAt = statusEndAt - 24 * 60 * 60 * 1000;

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center justify-end border-b px-4 py-3">
				{createDialog}
			</div>

			<div className="scroll-fade flex-1 overflow-auto p-4">
				{jobs.length === 0 ? (
					<Empty className="h-full">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={ZapIcon} />
							</EmptyMedia>
							<EmptyTitle>No automations yet</EmptyTitle>
							<EmptyDescription>
								Schedule an agent or workflow to run hourly, daily, weekly, or
								on any cadence — without writing a cron expression.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>{createDialog}</EmptyContent>
					</Empty>
				) : (
					<>
						<div className="mb-4 flex flex-col gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div>
									<p className="font-medium text-sm">All scheduled jobs</p>
									<p className="text-muted-foreground text-xs">
										{tl(
											"Run status · last 24 hours · {jobCount, plural, one {{jobs} job} other {{jobs} jobs}} · {runCount, plural, one {{runs} run} other {{runs} runs}}",
											{
												jobCount: jobs.length,
												jobs: String(jobs.length),
												runCount: statusRuns.length,
												runs: String(statusRuns.length),
											}
										)}
									</p>
									<p className="text-muted-foreground text-xs">
										Green completed, red failed, amber scheduled or waiting.
									</p>
								</div>
								<RunStatusTimelineLegend
									statuses={["success", "failure", "scheduled", "waiting"]}
								/>
							</div>
							<RunStatusTimeline
								ariaLabel="All scheduled job run status in the last 24 hours"
								endAt={statusEndAt}
								entries={statusRuns}
								showScale
								startAt={statusStartAt}
							/>
						</div>
						<div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
							{jobs.map((job) => (
								<JobCard
									job={job}
									key={job.id}
									onDelete={onDelete}
									timelineEndAt={statusEndAt}
								/>
							))}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
