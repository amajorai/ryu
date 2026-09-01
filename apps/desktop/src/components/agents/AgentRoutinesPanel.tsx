import {
	CheckmarkCircle02Icon,
	Delete02Icon,
	Edit02Icon,
	PlayIcon,
	PlusSignIcon,
	Refresh01Icon,
	Time04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import {
	RunStatusTimeline,
	RunStatusTimelineLegend,
} from "@ryu/ui/components/run-status-timeline";
import { toast } from "@ryu/ui/components/sileo";
import { Switch } from "@ryu/ui/components/switch";
import { Textarea } from "@ryu/ui/components/textarea";
import { cn } from "@ryu/ui/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { useMemo, useState } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useSchedules } from "@/src/hooks/useSchedules.ts";
import type {
	JobTarget,
	Schedule,
	ScheduledJob,
} from "@/src/lib/api/schedules.ts";
import {
	buildCalendarEvents,
	buildRunStatusTimelineEntries,
	describeSchedule,
	groupEventsByJob,
} from "@/src/lib/calendar/events.ts";

type RoutineStatus = "failed" | "none" | "operational" | "paused" | "scheduled";

const STATUS_META: Record<
	RoutineStatus,
	{ className: string; dotClassName: string; label: string }
> = {
	failed: {
		className: "text-destructive",
		dotClassName: "bg-destructive",
		label: "Failed",
	},
	none: {
		className: "text-muted-foreground",
		dotClassName: "bg-muted-foreground/45",
		label: "No runs",
	},
	operational: {
		className: "text-success",
		dotClassName: "bg-success",
		label: "Operational",
	},
	paused: {
		className: "text-muted-foreground",
		dotClassName: "bg-muted-foreground/50",
		label: "Paused",
	},
	scheduled: {
		className: "text-warning",
		dotClassName: "bg-warning",
		label: "Scheduled",
	},
};

interface RoutineDraft {
	conversationId: string;
	destination: "new" | "existing";
	enabled: boolean;
	name: string;
	prompt: string;
	requireApproval: boolean;
	scheduleKind: "cron" | "every";
	scheduleValue: string;
	timezone: string;
}

type EditorMode = { kind: "edit"; job: ScheduledJob } | { kind: "new" } | null;

function defaultDraft(): RoutineDraft {
	return {
		conversationId: "",
		destination: "new",
		enabled: true,
		name: "",
		prompt: "",
		requireApproval: false,
		scheduleKind: "every",
		scheduleValue: "1h",
		timezone: "UTC",
	};
}

function draftFromJob(job: ScheduledJob): RoutineDraft {
	const target = job.target.type === "agent" ? job.target : null;
	return {
		conversationId: target?.conversationId ?? "",
		destination: target?.conversationId ? "existing" : "new",
		enabled: job.enabled,
		name: job.name,
		prompt: target?.prompt ?? "",
		requireApproval: job.requireApproval,
		scheduleKind: job.schedule.kind,
		scheduleValue:
			job.schedule.kind === "cron" ? job.schedule.expr : job.schedule.interval,
		timezone: job.schedule.kind === "cron" ? (job.schedule.tz ?? "UTC") : "UTC",
	};
}

function statusForJob(
	job: ScheduledJob,
	events: ReturnType<typeof buildCalendarEvents>
): RoutineStatus {
	if (!job.enabled) {
		return "paused";
	}
	const latest = [...job.history].sort(
		(a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
	)[0];
	if (latest?.outcome === "failure" || job.lastOutcome === "failure") {
		return "failed";
	}
	if (latest?.outcome === "success" || job.lastOutcome === "success") {
		return "operational";
	}
	return events.some((event) => event.kind === "upcoming")
		? "scheduled"
		: "none";
}

function StatusPill({ status }: { status: RoutineStatus }) {
	const meta = STATUS_META[status];
	return (
		<span
			className={cn("inline-flex items-center gap-1.5 text-xs", meta.className)}
		>
			<span
				aria-hidden="true"
				className={cn("size-1.5 rounded-full", meta.dotClassName)}
			/>
			{meta.label}
		</span>
	);
}

function formatLastRun(job: ScheduledJob): string {
	if (!job.lastRunAt) {
		return "No runs yet";
	}
	const timestamp = Date.parse(job.lastRunAt);
	if (!Number.isFinite(timestamp)) {
		return "Last run unavailable";
	}
	return `Last run ${formatDistanceToNow(new Date(timestamp), { addSuffix: true })}`;
}

function toSchedule(draft: RoutineDraft): Schedule {
	if (draft.scheduleKind === "cron") {
		return {
			kind: "cron",
			expr: draft.scheduleValue.trim(),
			tz: draft.timezone.trim() || null,
		};
	}
	return { kind: "every", interval: draft.scheduleValue.trim() };
}

function toTarget(agentId: string, draft: RoutineDraft): JobTarget {
	return {
		type: "agent",
		agentId,
		conversationId:
			draft.destination === "existing" ? draft.conversationId : null,
		prompt: draft.prompt.trim(),
	};
}

function RoutineEditor({
	draft,
	conversations,
	disabled,
	onChange,
	onClose,
	onSave,
	saving,
	error,
	mode,
}: {
	draft: RoutineDraft;
	conversations: ReturnType<typeof useChatHistoryContext>["conversations"];
	disabled: boolean;
	onChange: (patch: Partial<RoutineDraft>) => void;
	onClose: () => void;
	onSave: () => void;
	saving: boolean;
	error: string | null;
	mode: Exclude<EditorMode, null>;
}) {
	return (
		<Dialog onOpenChange={(open) => !open && onClose()} open>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{mode.kind === "new" ? "Add routine" : "Edit routine"}
					</DialogTitle>
					<DialogDescription>
						Choose when this agent runs, what it should do, and where its
						transcript lives.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-1">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="agent-routine-name">Routine name</Label>
						<Input
							disabled={disabled || saving}
							id="agent-routine-name"
							onChange={(event) => onChange({ name: event.target.value })}
							placeholder="Morning research brief"
							value={draft.name}
						/>
					</div>

					<div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_1fr]">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-routine-frequency">Frequency</Label>
							<NativeSelect
								className="w-full"
								disabled={disabled || saving}
								id="agent-routine-frequency"
								onChange={(event) =>
									onChange({
										scheduleKind: event.target.value as "cron" | "every",
									})
								}
								value={draft.scheduleKind}
							>
								<NativeSelectOption value="every">
									Every interval
								</NativeSelectOption>
								<NativeSelectOption value="cron">
									Cron expression
								</NativeSelectOption>
							</NativeSelect>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-routine-schedule-value">
								{draft.scheduleKind === "cron" ? "Cron" : "Interval"}
							</Label>
							<Input
								className="font-mono"
								disabled={disabled || saving}
								id="agent-routine-schedule-value"
								onChange={(event) =>
									onChange({ scheduleValue: event.target.value })
								}
								placeholder={
									draft.scheduleKind === "cron" ? "0 9 * * 1-5" : "1h"
								}
								value={draft.scheduleValue}
							/>
						</div>
					</div>

					{draft.scheduleKind === "cron" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-routine-timezone">Time zone</Label>
							<Input
								disabled={disabled || saving}
								id="agent-routine-timezone"
								onChange={(event) => onChange({ timezone: event.target.value })}
								placeholder="UTC"
								value={draft.timezone}
							/>
						</div>
					) : null}

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="agent-routine-prompt">Instructions</Label>
						<Textarea
							disabled={disabled || saving}
							id="agent-routine-prompt"
							onChange={(event) => onChange({ prompt: event.target.value })}
							placeholder="Review the latest project activity and summarize what needs attention."
							rows={4}
							value={draft.prompt}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="agent-routine-destination">
							Transcript destination
						</Label>
						<NativeSelect
							className="w-full"
							disabled={disabled || saving}
							id="agent-routine-destination"
							onChange={(event) =>
								onChange({
									destination: event.target.value as "new" | "existing",
								})
							}
							value={draft.destination}
						>
							<NativeSelectOption value="new">
								New chat each run
							</NativeSelectOption>
							<NativeSelectOption value="existing">
								Keep one persistent chat
							</NativeSelectOption>
						</NativeSelect>
						<p className="text-muted-foreground text-xs">
							{draft.destination === "new"
								? "Each firing gets a clean durable transcript you can open from history."
								: "Every firing appends to the selected chat, including when it was started from that chat."}
						</p>
					</div>

					{draft.destination === "existing" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-routine-chat">Persistent chat</Label>
							<NativeSelect
								className="w-full"
								disabled={disabled || saving || conversations.length === 0}
								id="agent-routine-chat"
								onChange={(event) =>
									onChange({ conversationId: event.target.value })
								}
								value={draft.conversationId}
							>
								{conversations.length === 0 ? (
									<NativeSelectOption value="">
										No agent chats yet
									</NativeSelectOption>
								) : (
									conversations.map((conversation) => (
										<NativeSelectOption
											key={conversation.id}
											value={conversation.id}
										>
											{conversation.title || "Untitled chat"}
										</NativeSelectOption>
									))
								)}
							</NativeSelect>
						</div>
					) : null}

					<div className="flex flex-col gap-3 rounded-lg border p-3">
						<label
							className="flex items-center justify-between gap-3"
							htmlFor="agent-routine-enabled"
						>
							<span className="flex flex-col gap-0.5">
								<span className="font-medium text-sm">Enabled</span>
								<span className="text-muted-foreground text-xs">
									Pause it without losing the routine or its history.
								</span>
							</span>
							<Switch
								checked={draft.enabled}
								disabled={disabled || saving}
								id="agent-routine-enabled"
								onCheckedChange={(enabled) => onChange({ enabled })}
							/>
						</label>
						<label
							className="flex items-center justify-between gap-3"
							htmlFor="agent-routine-approval"
						>
							<span className="flex flex-col gap-0.5">
								<span className="font-medium text-sm">Ask before each run</span>
								<span className="text-muted-foreground text-xs">
									Send the firing to your Inbox for approval.
								</span>
							</span>
							<Switch
								checked={draft.requireApproval}
								disabled={disabled || saving}
								id="agent-routine-approval"
								onCheckedChange={(requireApproval) =>
									onChange({ requireApproval })
								}
							/>
						</label>
					</div>

					{error ? <p className="text-destructive text-sm">{error}</p> : null}
				</div>

				<DialogFooter>
					<Button disabled={saving} onClick={onClose} variant="ghost">
						Cancel
					</Button>
					<Button disabled={disabled} loading={saving} onClick={onSave}>
						{mode.kind === "new" ? "Add routine" : "Save routine"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function AgentRoutinesPanel({
	agentId,
	disabled = false,
}: {
	agentId: string;
	disabled?: boolean;
}) {
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
				caption="Routines are durable schedules. Each run is recorded here and can either start a fresh chat or append to one persistent conversation."
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
				<div className="flex flex-col gap-3" data-testid="agent-routines-panel">
					<div data-testid="agent-routines-overview">
						<SettingsCard className="flex flex-col gap-3">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div>
									<div className="flex items-center gap-2">
										{overallStatus === "operational" ? (
											<HugeiconsIcon
												className="size-4 text-success"
												icon={CheckmarkCircle02Icon}
											/>
										) : null}
										<p className="font-medium text-sm">Routine health</p>
										<StatusPill status={overallStatus} />
									</div>
									<p className="mt-1 text-muted-foreground text-xs">
										{routines.length}{" "}
										{routines.length === 1 ? "routine" : "routines"} ·{" "}
										{overview.runs} runs in the last 24 hours
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
							<div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs">
								<span className="text-success">
									{overview.operational} operational
								</span>
								<span className="text-destructive">
									{overview.failed} failed
								</span>
								<span className="text-muted-foreground">
									{overview.paused} paused
								</span>
							</div>
						</SettingsCard>
					</div>

					{error ? (
						<p className="px-3 text-destructive text-sm">{error}</p>
					) : null}
					{routines.length === 0 ? (
						<SettingsCard className="flex flex-col items-center gap-2 py-8 text-center">
							<HugeiconsIcon
								className="size-6 text-muted-foreground"
								icon={Time04Icon}
							/>
							<p className="font-medium text-sm">No routines yet</p>
							<p className="max-w-sm text-muted-foreground text-xs">
								Add a routine to let this agent work on its own and keep every
								result traceable.
							</p>
							<Button disabled={disabled} onClick={openNew} size="sm">
								<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
								Add first routine
							</Button>
						</SettingsCard>
					) : (
						<div className="flex flex-col gap-2" role="list">
							{routines.map((job) => {
								const jobEvents = eventsByJob.get(job.id) ?? [];
								const status = statusForJob(job, jobEvents);
								return (
									<div data-testid="agent-routine-row" key={job.id}>
										<SettingsCard className="flex flex-col gap-3">
											<div className="flex flex-wrap items-start gap-3">
												<div className="min-w-0 flex-1">
													<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
														<p className="truncate font-medium text-sm">
															{job.name}
														</p>
														<StatusPill status={status} />
													</div>
													<p className="mt-1 truncate text-muted-foreground text-xs">
														{describeSchedule(job.schedule)} ·{" "}
														{job.target.type === "agent" &&
														job.target.conversationId
															? "Persistent chat"
															: "New chat each run"}
													</p>
													<p className="mt-0.5 text-muted-foreground text-xs">
														{formatLastRun(job)}
													</p>
												</div>
												<div className="flex shrink-0 items-center gap-1">
													<Button
														disabled={disabled || runningId === job.id}
														loading={runningId === job.id}
														onClick={() => executeRun(job)}
														size="icon-sm"
														variant="ghost"
													>
														<span className="sr-only">Run {job.name} now</span>
														<HugeiconsIcon className="size-4" icon={PlayIcon} />
													</Button>
													<Button
														aria-label={`Edit ${job.name}`}
														disabled={disabled}
														onClick={() => openEdit(job)}
														size="icon-sm"
														variant="ghost"
													>
														<HugeiconsIcon
															className="size-4"
															icon={Edit02Icon}
														/>
													</Button>
													<Button
														aria-label={`Delete ${job.name}`}
														disabled={disabled}
														onClick={() => setDeleteTarget(job)}
														size="icon-sm"
														variant="ghost"
													>
														<HugeiconsIcon
															className="size-4 text-destructive"
															icon={Delete02Icon}
														/>
													</Button>
												</div>
											</div>
											<RunStatusTimeline
												ariaLabel={`${job.name} run status for the last 24 hours`}
												endAt={windowEnd.getTime()}
												entries={buildRunStatusTimelineEntries(
													windowStart,
													windowEnd,
													jobEvents
												)}
												startAt={windowStart.getTime()}
											/>
										</SettingsCard>
									</div>
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
							Delete {deleteTarget?.name ?? "this routine"} and its saved
							schedule. Existing chat transcripts remain available in history.
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
