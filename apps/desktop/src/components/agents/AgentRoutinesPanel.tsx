import {
	CheckmarkCircle02Icon,
	PlusSignIcon,
	Refresh01Icon,
	Time04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	RunStatusTimeline,
	RunStatusTimelineLegend,
} from "@ryu/ui/components/run-status-timeline.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useMemo, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import { QuietEmpty } from "@/src/components/agents/shared/quiet-empty.tsx";
import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useSchedules } from "@/src/hooks/useSchedules.ts";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import {
	buildCalendarEvents,
	buildRunStatusTimelineEntries,
	groupEventsByJob,
} from "@/src/lib/calendar/events.ts";
import { RoutineEditor } from "./AgentRoutinesPanel-editor.tsx";
import {
	defaultDraft,
	draftFromJob,
	type EditorMode,
	type RoutineDraft,
	type RoutineStatus,
	statusForJob,
	toSchedule,
	toTarget,
} from "./AgentRoutinesPanel-model.ts";
import { RoutineRow } from "./AgentRoutinesPanel-routine-row.tsx";
import { StatusPill } from "./AgentRoutinesPanel-status-pill.tsx";

export function AgentRoutinesPanel({
	agentId,
	disabled = false,
}: {
	agentId: string;
	disabled?: boolean;
}) {
	const tl = useLiteralMessages();
	const { conversations } = useChatHistoryContext();
	const { create, error, jobs, loading, reload, remove, runNow, update } =
		useSchedules();
	const [editorMode, setEditorMode] = useState<EditorMode>(null);
	const [draft, setDraft] = useState<RoutineDraft>(defaultDraft);
	const [editorError, setEditorError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [runningId, setRunningId] = useState<string | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<ScheduledJob | null>(null);

	const agentConversations = useMemo(
		() =>
			conversations
				.filter((conversation) => conversation.agentId === agentId)
				.sort((a, b) => b.updatedAt - a.updatedAt),
		[agentId, conversations]
	);
	const routines = useMemo(
		() =>
			jobs.filter(
				(job) =>
					!job.system &&
					job.target.type === "agent" &&
					job.target.agentId === agentId
			),
		[agentId, jobs]
	);
	const { events, eventsByJob, overview, windowEnd, windowStart } =
		useMemo(() => {
			const now = new Date();
			const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
			const eventList = buildCalendarEvents(routines, start, now);
			const grouped = groupEventsByJob(eventList);
			const statuses = routines.map((job) =>
				statusForJob(job, grouped.get(job.id) ?? [])
			);
			return {
				events: eventList,
				eventsByJob: grouped,
				overview: {
					failed: statuses.filter((status) => status === "failed").length,
					none: statuses.filter((status) => status === "none").length,
					operational: statuses.filter((status) => status === "operational")
						.length,
					paused: statuses.filter((status) => status === "paused").length,
					runs: eventList.filter((event) => event.kind === "past").length,
					scheduled: statuses.filter((status) => status === "scheduled").length,
				},
				windowEnd: now,
				windowStart: start,
			};
		}, [routines]);
	const overallStatus: RoutineStatus =
		overview.failed > 0
			? "failed"
			: routines.length > 0 && overview.paused === routines.length
				? "paused"
				: overview.failed === 0 && overview.operational > 0
					? "operational"
					: overview.scheduled > 0
						? "scheduled"
						: "none";

	const openNew = () => {
		setEditorMode({ kind: "new" });
		setDraft(defaultDraft());
		setEditorError(null);
	};
	const openEdit = (job: ScheduledJob) => {
		setEditorMode({ kind: "edit", job });
		setDraft(draftFromJob(job));
		setEditorError(null);
	};
	const closeEditor = () => {
		if (saving) {
			return;
		}
		setEditorMode(null);
		setEditorError(null);
	};
	const saveRoutine = async () => {
		if (!draft.name.trim()) {
			setEditorError("Give this routine a name.");
			return;
		}
		if (!draft.scheduleValue.trim()) {
			setEditorError("Enter a cron expression or interval.");
			return;
		}
		if (!draft.prompt.trim()) {
			setEditorError("Add instructions for the agent to run.");
			return;
		}
		if (draft.destination === "existing" && !draft.conversationId) {
			setEditorError("Select a persistent chat.");
			return;
		}
		setSaving(true);
		setEditorError(null);
		try {
			const input = {
				name: draft.name.trim(),
				schedule: toSchedule(draft),
				target: toTarget(agentId, draft),
				enabled: draft.enabled,
				requireApproval: draft.requireApproval,
			};
			if (editorMode?.kind === "edit") {
				await update(editorMode.job.id, input);
				toast.success("Routine saved");
			} else {
				await create(input);
				toast.success("Routine added");
			}
			setEditorMode(null);
		} catch (cause) {
			setEditorError(
				cause instanceof Error ? cause.message : "Routine could not be saved."
			);
		} finally {
			setSaving(false);
		}
	};
	const executeRun = async (job: ScheduledJob) => {
		setRunningId(job.id);
		try {
			await runNow(job.id);
			toast.success("Routine run completed");
		} catch (cause) {
			toast.error(
				cause instanceof Error ? cause.message : "Routine run failed"
			);
		} finally {
			setRunningId(null);
		}
	};
	const executeDelete = async () => {
		if (!deleteTarget) {
			return;
		}
		setDeletingId(deleteTarget.id);
		try {
			await remove(deleteTarget.id);
			toast.success("Routine deleted");
			setDeleteTarget(null);
		} catch (cause) {
			toast.error(
				cause instanceof Error ? cause.message : "Routine could not be deleted."
			);
		} finally {
			setDeletingId(null);
		}
	};

	const mode = editorMode;
	return (
		<>
			<SettingsSection
				caption="Each run starts a fresh chat or appends to one persistent conversation."
				headerAction={
					<div className="flex items-center gap-1">
						<Button
							disabled={disabled || loading}
							onClick={() => reload()}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
							Refresh
						</Button>
						<Button
							disabled={disabled}
							onClick={openNew}
							size="sm"
							variant="outline"
						>
							<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
							Add routine
						</Button>
					</div>
				}
				title="Routines"
			>
				<div className="flex flex-col gap-4" data-testid="agent-routines-panel">
					<div data-testid="agent-routines-overview">
						<div className="flex flex-col gap-3">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div>
									<div className="flex items-center gap-2">
										{overallStatus === "operational" ? (
											<HugeiconsIcon
												className="size-4 text-status-success"
												icon={CheckmarkCircle02Icon}
											/>
										) : null}
										<p className="font-medium text-sm">Routine health</p>
										<StatusPill status={overallStatus} />
									</div>
									<p className="mt-0.5 text-detail text-muted-foreground">
										{tl(
											"{routineCountLabel} {routineCount, plural, one {routine} other {routines}} · {runs} runs in the last 24 hours",
											{
												routineCount: routines.length,
												routineCountLabel: String(routines.length),
												runs: String(overview.runs),
											}
										)}
									</p>
								</div>
								<RunStatusTimelineLegend />
							</div>
							{(() => {
								return (
									<RunStatusTimeline
										ariaLabel="All agent routine status for the last 24 hours"
										endAt={windowEnd.getTime()}
										entries={buildRunStatusTimelineEntries(
											windowStart,
											windowEnd,
											events
										)}
										nowAt={windowEnd.getTime()}
										showScale
										startAt={windowStart.getTime()}
									/>
								);
							})()}
							<p className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs tabular-nums">
								{overview.operational > 0 ? (
									<span>
										{tl("{operational} operational", {
											operational: String(overview.operational),
										})}
									</span>
								) : null}
								{overview.failed > 0 ? (
									<span className="text-status-destructive">
										{tl("{failed} failed", { failed: String(overview.failed) })}
									</span>
								) : null}
								{overview.paused > 0 ? (
									<span>
										{tl("{paused} paused", { paused: String(overview.paused) })}
									</span>
								) : null}
							</p>
						</div>
					</div>

					{error ? <ErrorLine message={error} /> : null}
					{routines.length === 0 ? (
						<QuietEmpty
							action={
								<Button
									disabled={disabled}
									onClick={openNew}
									size="sm"
									variant="outline"
								>
									<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
									Add first routine
								</Button>
							}
							description="Let this agent work on its own, with every result traceable."
							icon={Time04Icon}
							title="No routines yet"
						/>
					) : (
						<div className="flex flex-col" role="list">
							{routines.map((job) => {
								const jobEvents = eventsByJob.get(job.id) ?? [];
								const status = statusForJob(job, jobEvents);
								return (
									<RoutineRow
										disabled={disabled}
										job={job}
										jobEvents={jobEvents}
										key={job.id}
										onDelete={() => setDeleteTarget(job)}
										onEdit={() => openEdit(job)}
										onRun={() => executeRun(job)}
										running={runningId === job.id}
										status={status}
										windowEnd={windowEnd}
										windowStart={windowStart}
									/>
								);
							})}
						</div>
					)}
				</div>
			</SettingsSection>

			{mode ? (
				<RoutineEditor
					conversations={agentConversations}
					disabled={disabled}
					draft={draft}
					error={editorError}
					mode={mode}
					onChange={(patch) =>
						setDraft((current) => ({ ...current, ...patch }))
					}
					onClose={closeEditor}
					onSave={() => saveRoutine().catch(() => undefined)}
					saving={saving}
				/>
			) : null}

			<AlertDialog
				onOpenChange={(open) => !open && setDeleteTarget(null)}
				open={deleteTarget !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this routine?</AlertDialogTitle>
						<AlertDialogDescription>
							{tl(
								"Delete {name} and its saved schedule. Existing chat transcripts remain available in history.",
								{ name: deleteTarget?.name ?? tl("this routine") }
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deletingId !== null}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={deletingId !== null}
							loading={deletingId !== null}
							onClick={() => executeDelete().catch(() => undefined)}
						>
							Delete routine
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
