"use client";

import { Add01Icon, CancelCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription, AlertTitle } from "@ryu/ui/components/alert";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
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
import type {
	AgentOption,
	CreateSchedulePayload,
	ScheduleKind,
	TargetKind,
	WorkflowOption,
} from "./schedules-types.ts";

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

export function CreateAutomationDialog<Result>({
	onCreate,
	agents,
	agentsLoading,
	workflows,
	workflowsLoading,
}: {
	onCreate?: (payload: CreateSchedulePayload) => Promise<Result>;
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
						<Select<TargetKind>
							items={TARGET_OPTIONS}
							onValueChange={(v) => v && setTargetKind(v)}
							value={targetKind}
						>
							<SelectTrigger aria-label="Run">
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
						<Select<PhrasedKind>
							items={PHRASE_OPTIONS.map((opt) => ({
								value: opt.kind,
								label: opt.label,
							}))}
							onValueChange={(v) => v && setPhraseKind(v)}
							value={phraseKind}
						>
							<SelectTrigger aria-label="Schedule">
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
