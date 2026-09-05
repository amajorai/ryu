// The two cross-object reads: the task inbox and the pipeline report.
//
// Both are deliberately NOT per-object views. A follow-up you owe does not care
// which object it hangs off, and "how is the pipeline doing" is a question about a
// status field wherever it lives — so both read across the whole database and the
// rail reaches them outside the object list.
//
// The task windows (overdue / today / upcoming) are bucketed by the SERVER against
// the caller's UTC offset, not here. Two clients in different zones therefore agree
// on where "today" begins, and the panel does no date arithmetic it could get
// wrong.

import { Alert01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Skeleton } from "@ryu/ui/components/skeleton";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useState } from "react";
import { formatCents } from "@/src/components/panels/crm/fields.tsx";
import type {
	Activity,
	CrmClient,
	CrmSummary,
	PipelineReport,
} from "@/src/lib/api/crm.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";

const WINDOWS = [
	{ label: "Overdue", value: "overdue" },
	{ label: "Today", value: "today" },
	{ label: "Upcoming", value: "upcoming" },
] as const;

type Window = (typeof WINDOWS)[number]["value"];

export function Insights({
	client,
	onOpenRecord,
}: {
	client: CrmClient;
	onOpenRecord: (recordId: string) => void;
}) {
	const [window, setWindow] = useState<Window>("today");
	const [tasks, setTasks] = useState<Activity[]>([]);
	const [pipeline, setPipeline] = useState<PipelineReport | null>(null);
	const [summary, setSummary] = useState<CrmSummary | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true);
			setError(null);
			try {
				// Issued together: the page is not usable until all three land, so
				// awaiting them in sequence would triple time-to-paint for no gain.
				// The pipeline read is allowed to fail on its own — a node with no
				// status field anywhere has no pipeline, and that is not an error
				// worth blanking the task inbox over.
				const [taskPage, summaryResult, pipelineResult] = await Promise.all([
					client.getTasks({ window }, signal),
					client.getSummary(signal),
					client.getPipeline({}, signal).catch(() => null),
				]);
				setTasks(taskPage.items);
				setSummary(summaryResult);
				setPipeline(pipelineResult);
			} catch (cause) {
				if (!signal?.aborted) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			} finally {
				if (!signal?.aborted) {
					setLoading(false);
				}
			}
		},
		[client, window]
	);

	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);

	const toggle = async (task: Activity) => {
		const completed = !task.completed_at;
		setTasks((current) =>
			current.map((row) =>
				row.id === task.id
					? {
							...row,
							completed_at: completed ? new Date().toISOString() : null,
						}
					: row
			)
		);
		try {
			await client.completeActivity(task.id, completed);
		} catch (cause) {
			setTasks((current) =>
				current.map((row) =>
					row.id === task.id ? { ...row, completed_at: task.completed_at } : row
				)
			);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center justify-between gap-2 border-b px-4 py-3">
				<h2 className="font-medium text-base">Follow-ups & pipeline</h2>
				<Button
					disabled={loading}
					onClick={() => void load()}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon icon={RefreshIcon} size={14} />
					Refresh
				</Button>
			</header>

			{error && (
				<div className="flex items-start gap-2 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
					<HugeiconsIcon icon={Alert01Icon} size={14} />
					<span>{error}</span>
				</div>
			)}

			<div className="scroll-fade min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
				{summary && (
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
						<Stat label="Records" value={summary.total_records} />
						<Stat label="Open tasks" value={summary.open_tasks} />
						<Stat label="Overdue" value={summary.overdue_tasks} />
					</div>
				)}

				<section>
					<div className="mb-2 flex items-center gap-1">
						{WINDOWS.map((option) => (
							<Button
								key={option.value}
								onClick={() => setWindow(option.value)}
								size="sm"
								variant={window === option.value ? "secondary" : "ghost"}
							>
								{option.label}
							</Button>
						))}
					</div>
					{loading && tasks.length === 0 ? (
						<Skeleton className="h-24 w-full" />
					) : (
						<ul className="space-y-1">
							{tasks.map((task) => (
								<li
									className="flex items-start gap-2 rounded-md border bg-card p-2"
									key={task.id}
								>
									<Checkbox
										aria-label={
											task.completed_at
												? `Reopen ${task.title}`
												: `Complete ${task.title}`
										}
										checked={Boolean(task.completed_at)}
										className="mt-0.5"
										onCheckedChange={() => void toggle(task)}
									/>
									<div className="min-w-0 flex-1">
										<button
											className={cn(
												"truncate text-left text-sm",
												task.completed_at &&
													"text-muted-foreground line-through"
											)}
											disabled={!task.record_id}
											onClick={() =>
												task.record_id && onOpenRecord(task.record_id)
											}
											type="button"
										>
											{task.title || "(untitled)"}
										</button>
										{task.due_at && (
											<div className="text-muted-foreground text-xs">
												due {formatDateTime(task.due_at)}
												{task.assignee ? ` · ${task.assignee}` : ""}
											</div>
										)}
									</div>
								</li>
							))}
							{!loading && tasks.length === 0 && (
								<li className="py-6 text-center text-muted-foreground text-sm">
									Nothing {window === "overdue" ? "overdue" : `for ${window}`}.
								</li>
							)}
						</ul>
					)}
				</section>

				{pipeline && (
					<section>
						<div className="mb-2 flex items-baseline justify-between gap-2">
							<h3 className="font-medium text-sm">Pipeline</h3>
							<span className="text-muted-foreground text-xs">
								<span className="font-mono tabular-nums">
									{formatCents(
										pipeline.total_value_cents,
										pipeline.currency_code
									)}
								</span>{" "}
								across {formatNumber(pipeline.total_records)} ·{" "}
								{Math.round(pipeline.win_rate * 100)}% win rate
							</span>
						</div>
						<ul className="space-y-1">
							{pipeline.stages.map((stage) => (
								<li key={stage.option_id}>
									<div className="flex items-baseline justify-between gap-2 text-sm">
										<span className="flex min-w-0 items-center gap-2">
											{stage.color && (
												<span
													aria-hidden="true"
													className="size-2 shrink-0 rounded-full"
													style={{ backgroundColor: stage.color }}
												/>
											)}
											<span className="truncate">{stage.label}</span>
											{stage.is_won && (
												<Badge className="font-normal" variant="secondary">
													won
												</Badge>
											)}
											{stage.is_lost && (
												<Badge className="font-normal" variant="outline">
													lost
												</Badge>
											)}
										</span>
										<span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
											{stage.record_count} ·{" "}
											{formatCents(stage.value_cents, pipeline.currency_code)}
										</span>
									</div>
									{/* A share bar rather than a chart: one dimension, read at a
									    glance, and no charting dependency for four rows. */}
									<div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-muted">
										<div
											className="h-full bg-primary"
											style={{
												width: `${Math.max(0, Math.min(100, stage.share * 100))}%`,
											}}
										/>
									</div>
								</li>
							))}
						</ul>
						{pipeline.unassigned_count > 0 && (
							<p className="mt-1 text-muted-foreground text-xs">
								{pipeline.unassigned_count} with no stage set.
							</p>
						)}
					</section>
				)}
			</div>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-md border bg-card p-3">
			<div className="font-medium text-lg tabular-nums">
				{formatNumber(value)}
			</div>
			<div className="text-muted-foreground text-xs">{label}</div>
		</div>
	);
}
