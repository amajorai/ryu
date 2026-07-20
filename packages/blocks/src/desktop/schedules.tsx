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

import {
	Add01Icon,
	CancelCircleIcon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	Delete01Icon,
	WorkflowSquare01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription, AlertTitle } from "@ryu/ui/components/alert";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";
import { useState } from "react";

export type ScheduleOutcome = "success" | "failure";

/** A scheduled job, pre-formatted by the container for display. */
export interface ScheduleRow {
	/** When the job runs an agent, its id (shown as a badge); else null. */
	agentId: string | null;
	enabled: boolean;
	id: string;
	/** The latest execution's error, if the last run failed. */
	lastError?: string | null;
	lastOutcome: ScheduleOutcome | null;
	/** Human last-run string, e.g. "2 hours ago" or "Never". */
	lastRunLabel: string;
	name: string;
	/** Human schedule phrase, e.g. "Daily at 8 AM" or "Every hour". */
	scheduleLabel: string;
	/** When the job runs a workflow, its resolved name; else null. */
	workflowName: string | null;
}

export interface AgentOption {
	id: string;
	name: string;
}

export interface WorkflowOption {
	id: string;
	name: string;
}

export type TargetKind = "agent" | "workflow";

export type ScheduleKind =
	| { kind: "every"; interval: string }
	| { kind: "cron"; expr: string };

/** The payload the container persists when the dialog form is submitted. */
export interface CreateSchedulePayload {
	enabled: boolean;
	name: string;
	schedule: ScheduleKind;
	target:
		| { type: "agent"; agentId: string; prompt: string }
		| { type: "workflow"; workflowId: string; input: Record<string, string> };
}

export interface SchedulesViewProps {
	agents: AgentOption[];
	agentsLoading?: boolean;
	error?: string | null;
	jobs: ScheduleRow[];
	loading?: boolean;
	onCreate?: (payload: CreateSchedulePayload) => Promise<unknown>;
	onDelete?: (id: string) => void;
	workflows: WorkflowOption[];
	workflowsLoading?: boolean;
}

// ── Schedule phrase helpers ───────────────────────────────────────────────────

type PhrasedKind =
	| "every_hour"
	| "every_day"
	| "every_week"
	| "every_5m"
	| "every_10m"
	| "every_15m"
	| "every_30m"
	| "custom";

const PHRASE_OPTIONS: { kind: PhrasedKind; label: string }[] = [
	{ kind: "every_5m", label: "Every 5 minutes" },
	{ kind: "every_10m", label: "Every 10 minutes" },
	{ kind: "every_15m", label: "Every 15 minutes" },
	{ kind: "every_30m", label: "Every 30 minutes" },
	{ kind: "every_hour", label: "Every hour" },
	{ kind: "every_day", label: "Every day at…" },
	{ kind: "every_week", label: "Every week on…" },
	{ kind: "custom", label: "Custom (cron expression)" },
];

const DAYS_OF_WEEK = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

function buildSchedule(
	kind: PhrasedKind,
	hour: number,
	weekday: number,
	customCron: string
): ScheduleKind {
	switch (kind) {
		case "every_5m":
			return { kind: "every", interval: "5m" };
		case "every_10m":
			return { kind: "every", interval: "10m" };
		case "every_15m":
			return { kind: "every", interval: "15m" };
		case "every_30m":
			return { kind: "every", interval: "30m" };
		case "every_hour":
			return { kind: "every", interval: "1h" };
		case "every_day":
			return { kind: "cron", expr: `0 ${hour} * * *` };
		case "every_week":
			return { kind: "cron", expr: `0 ${hour} * * ${weekday}` };
		default:
			return { kind: "cron", expr: customCron.trim() };
	}
}

function formatHour(h: number): string {
	if (h === 0) {
		return "12 AM";
	}
	if (h === 12) {
		return "12 PM";
	}
	return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

const TARGET_OPTIONS: { value: TargetKind; label: string }[] = [
	{ value: "agent", label: "Agent" },
	{ value: "workflow", label: "Workflow" },
];

// ── Create dialog ─────────────────────────────────────────────────────────────

function CreateAutomationDialog({
	onCreate,
	agents,
	agentsLoading,
	workflows,
	workflowsLoading,
}: {
	onCreate?: (payload: CreateSchedulePayload) => Promise<unknown>;
	agents: AgentOption[];
	agentsLoading?: boolean;
	workflows: WorkflowOption[];
	workflowsLoading?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [phraseKind, setPhraseKind] = useState<PhrasedKind>("every_hour");
	const [hour, setHour] = useState(9);
	const [weekday, setWeekday] = useState(1);
	const [customCron, setCustomCron] = useState("0 * * * *");
	const [targetKind, setTargetKind] = useState<TargetKind>("agent");
	const [agentId, setAgentId] = useState("");
	const [prompt, setPrompt] = useState("");
	const [workflowId, setWorkflowId] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const needsHour = phraseKind === "every_day" || phraseKind === "every_week";
	const needsWeekday = phraseKind === "every_week";
	const needsCustom = phraseKind === "custom";
	const isWorkflow = targetKind === "workflow";
	const targetIncomplete = isWorkflow ? !workflowId : !agentId;

	const reset = () => {
		setName("");
		setPhraseKind("every_hour");
		setHour(9);
		setWeekday(1);
		setCustomCron("0 * * * *");
		setTargetKind("agent");
		setAgentId("");
		setPrompt("");
		setWorkflowId("");
		setError(null);
	};

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		setSubmitting(true);
		try {
			const schedule = buildSchedule(phraseKind, hour, weekday, customCron);
			const target: CreateSchedulePayload["target"] = isWorkflow
				? { type: "workflow", workflowId: workflowId.trim(), input: {} }
				: { type: "agent", agentId: agentId.trim(), prompt: prompt.trim() };
			await onCreate?.({
				name: name.trim(),
				schedule,
				target,
				enabled: true,
			});
			reset();
			setOpen(false);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to create automation"
			);
		} finally {
			setSubmitting(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		if (!next) {
			reset();
		}
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={<Button size="sm" />}>
				<HugeiconsIcon className="size-4" icon={Add01Icon} />
				New automation
			</DialogTrigger>
			<DialogContent className="sm:max-w-[500px]">
				<DialogHeader>
					<DialogTitle>Create automation</DialogTitle>
					<DialogDescription>
						Run an agent or workflow on a recurring schedule — no cron expertise
						needed.
					</DialogDescription>
				</DialogHeader>
				<form className="space-y-4" onSubmit={handleSubmit}>
					<div className="space-y-2">
						<Label htmlFor="auto-name">Description</Label>
						<Input
							id="auto-name"
							onChange={(e) => setName(e.target.value)}
							placeholder="Nightly summary"
							required
							value={name}
						/>
					</div>

					<div className="space-y-2">
						<Label>Run</Label>
						<Select
							items={TARGET_OPTIONS}
							onValueChange={(v) => v && setTargetKind(v as TargetKind)}
							value={targetKind}
						>
							<SelectTrigger>
								<SelectValue placeholder="Pick what to run" />
							</SelectTrigger>
							<SelectContent>
								{TARGET_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{isWorkflow ? null : (
						<>
							<div className="space-y-2">
								<Label htmlFor="auto-agent">Agent</Label>
								{agentsLoading ? (
									<div className="flex items-center gap-2 text-muted-foreground text-sm">
										<Spinner className="size-4" />
										Loading agents…
									</div>
								) : (
									<Select
										items={agents.map((a) => ({ value: a.id, label: a.name }))}
										onValueChange={(v) => v && setAgentId(v)}
										value={agentId}
									>
										<SelectTrigger id="auto-agent">
											<SelectValue placeholder="Pick an agent" />
										</SelectTrigger>
										<SelectContent>
											{agents.map((a) => (
												<SelectItem key={a.id} value={a.id}>
													{a.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</div>

							<div className="space-y-2">
								<Label htmlFor="auto-prompt">Prompt</Label>
								<Textarea
									id="auto-prompt"
									onChange={(e) => setPrompt(e.target.value)}
									placeholder="Summarize today's activity"
									required
									value={prompt}
								/>
							</div>
						</>
					)}

					{isWorkflow ? (
						<div className="space-y-2">
							<Label htmlFor="auto-workflow">Workflow</Label>
							{workflowsLoading ? (
								<div className="flex items-center gap-2 text-muted-foreground text-sm">
									<Spinner className="size-4" />
									Loading workflows…
								</div>
							) : workflows.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									No workflows yet — create one on the Workflows page first.
								</p>
							) : (
								<Select
									items={workflows.map((w) => ({ value: w.id, label: w.name }))}
									onValueChange={(v) => v && setWorkflowId(v)}
									value={workflowId}
								>
									<SelectTrigger id="auto-workflow">
										<SelectValue placeholder="Pick a workflow" />
									</SelectTrigger>
									<SelectContent>
										{workflows.map((w) => (
											<SelectItem key={w.id} value={w.id}>
												{w.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</div>
					) : null}

					<div className="space-y-2">
						<Label>Schedule</Label>
						<Select
							items={PHRASE_OPTIONS.map((opt) => ({
								value: opt.kind,
								label: opt.label,
							}))}
							onValueChange={(v) => v && setPhraseKind(v as PhrasedKind)}
							value={phraseKind}
						>
							<SelectTrigger>
								<SelectValue placeholder="Choose a schedule" />
							</SelectTrigger>
							<SelectContent>
								{PHRASE_OPTIONS.map((opt) => (
									<SelectItem key={opt.kind} value={opt.kind}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{needsHour ? (
						<div className="space-y-2">
							<Label htmlFor="auto-hour">Hour (UTC)</Label>
							<Select
								items={Array.from({ length: 24 }, (_, i) => ({
									value: String(i),
									label: formatHour(i),
								}))}
								onValueChange={(v) => v && setHour(Number(v))}
								value={String(hour)}
							>
								<SelectTrigger id="auto-hour">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Array.from({ length: 24 }, (_, i) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: hours are a fixed 0-23 range
										<SelectItem key={i} value={String(i)}>
											{formatHour(i)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : null}

					{needsWeekday ? (
						<div className="space-y-2">
							<Label htmlFor="auto-weekday">Day of week</Label>
							<Select
								items={DAYS_OF_WEEK.map((day, i) => ({
									value: String(i),
									label: day,
								}))}
								onValueChange={(v) => v && setWeekday(Number(v))}
								value={String(weekday)}
							>
								<SelectTrigger id="auto-weekday">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DAYS_OF_WEEK.map((day, i) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: weekdays are a fixed 0-6 range
										<SelectItem key={i} value={String(i)}>
											{day}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : null}

					{needsCustom ? (
						<div className="space-y-2">
							<Label htmlFor="auto-cron">Cron expression (UTC)</Label>
							<Input
								id="auto-cron"
								onChange={(e) => setCustomCron(e.target.value)}
								placeholder="0 * * * *"
								required
								value={customCron}
							/>
							<p className="text-muted-foreground text-xs">
								Five-field cron: minute hour day month weekday
							</p>
						</div>
					) : null}

					{error ? (
						<Alert variant="destructive">
							<HugeiconsIcon className="size-4" icon={CancelCircleIcon} />
							<AlertTitle>Could not create automation</AlertTitle>
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					<DialogFooter>
						<Button
							onClick={() => handleOpenChange(false)}
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button disabled={submitting || targetIncomplete} type="submit">
							{submitting ? "Creating…" : "Create automation"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function OutcomeBadge({ outcome }: { outcome: ScheduleOutcome }) {
	if (outcome === "success") {
		return (
			<Badge className="gap-1" variant="secondary">
				<HugeiconsIcon
					className="size-3 text-green-600"
					icon={CheckmarkCircle02Icon}
				/>
				Succeeded
			</Badge>
		);
	}
	return (
		<Badge className="gap-1" variant="destructive">
			<HugeiconsIcon className="size-3" icon={CancelCircleIcon} />
			Failed
		</Badge>
	);
}

function JobCard({
	job,
	onDelete,
}: {
	job: ScheduleRow;
	onDelete?: (id: string) => void;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<HugeiconsIcon className="size-4 opacity-70" icon={ZapIcon} />
					{job.name}
				</CardTitle>
				<CardDescription className="flex flex-wrap items-center gap-2">
					<Badge className="gap-1" variant="secondary">
						<HugeiconsIcon className="size-3" icon={Clock01Icon} />
						{job.scheduleLabel}
					</Badge>
					{job.agentId ? (
						<Badge variant="secondary">{job.agentId}</Badge>
					) : (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon className="size-3" icon={WorkflowSquare01Icon} />
							{job.workflowName ?? "Workflow"}
						</Badge>
					)}
					{job.enabled ? null : <Badge variant="secondary">disabled</Badge>}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<div className="flex items-center gap-2 text-sm">
					{job.lastOutcome ? <OutcomeBadge outcome={job.lastOutcome} /> : null}
					<span className="text-muted-foreground">
						Last run: {job.lastRunLabel}
					</span>
				</div>
				{job.lastOutcome === "failure" && job.lastError ? (
					<p className="line-clamp-2 text-destructive text-xs">
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

export function SchedulesView({
	loading,
	error,
	jobs,
	agents,
	agentsLoading,
	workflows,
	workflowsLoading,
	onCreate,
	onDelete,
}: SchedulesViewProps) {
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

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center justify-end border-b px-4 py-3">
				{createDialog}
			</div>

			<div className="scroll-fade-effect-y flex-1 overflow-auto p-4">
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
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
						{jobs.map((job) => (
							<JobCard job={job} key={job.id} onDelete={onDelete} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}
