import { Delete01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { JobInput, Schedule } from "@/src/lib/api/schedules.ts";

export interface AgentScheduleDraft
	extends Pick<JobInput, "enabled" | "name" | "requireApproval" | "schedule"> {
	id: string;
	instructions: string;
}

interface AgentSchedulesPanelProps {
	disabled: boolean;
	onChange: (schedules: AgentScheduleDraft[]) => void;
	onRequestUpgrade?: () => void;
	schedules: AgentScheduleDraft[];
	upgradeRequired?: boolean;
}

function newSchedule(): AgentScheduleDraft {
	return {
		id: globalThis.crypto?.randomUUID?.() ?? `schedule-${Date.now()}`,
		name: "",
		schedule: { kind: "every", interval: "1h" },
		instructions: "",
		enabled: true,
		requireApproval: false,
	};
}

function scheduleValue(schedule: Schedule): string {
	return schedule.kind === "cron" ? schedule.expr : schedule.interval;
}

export function AgentSchedulesPanel({
	disabled,
	onChange,
	onRequestUpgrade,
	schedules,
	upgradeRequired = false,
}: AgentSchedulesPanelProps) {
	const tl = useLiteralMessages();
	const update = (index: number, patch: Partial<AgentScheduleDraft>) => {
		onChange(
			schedules.map((schedule, currentIndex) =>
				currentIndex === index ? { ...schedule, ...patch } : schedule
			)
		);
	};

	const updateSchedule = (index: number, kind: "cron" | "every") => {
		const schedule: Schedule =
			kind === "cron"
				? { kind: "cron", expr: "0 9 * * *", tz: "UTC" }
				: { kind: "every", interval: "1h" };
		update(index, { schedule });
	};

	return (
		<SettingsSection
			caption="Each entry becomes its own heartbeat job. Give every firing custom instructions so the same agent can do different work throughout the day."
			headerAction={
				<Button
					disabled={disabled || upgradeRequired}
					onClick={() => onChange([...schedules, newSchedule()])}
					size="sm"
					variant="outline"
				>
					<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
					Add schedule
				</Button>
			}
			title="Schedules"
		>
			{upgradeRequired ? (
				<SettingsCard className="flex items-center justify-between gap-3">
					<div>
						<p className="font-medium text-sm">Background runs are locked</p>
						<p className="text-muted-foreground text-xs">
							Unlock background runs to let this agent run on its schedules.
						</p>
					</div>
					<Button onClick={onRequestUpgrade} size="sm" variant="secondary">
						Unlock
					</Button>
				</SettingsCard>
			) : null}

			{!upgradeRequired && schedules.length === 0 ? (
				<SettingsCard>
					<p className="text-muted-foreground text-sm">
						No schedules yet. Add one for a recurring run with custom
						instructions.
					</p>
				</SettingsCard>
			) : null}

			{upgradeRequired
				? null
				: schedules.map((entry, index) => (
						<SettingsCard className="mb-2.5 flex flex-col gap-4" key={entry.id}>
							<div className="flex items-start gap-3">
								<div className="min-w-0 flex-1">
									<Label htmlFor={`agent-schedule-name-${entry.id}`}>
										Schedule name
									</Label>
									<Input
										className="mt-1.5"
										disabled={disabled}
										id={`agent-schedule-name-${entry.id}`}
										onChange={(event) =>
											update(index, { name: event.target.value })
										}
										placeholder={tl("Schedule {number}", {
											number: String(index + 1),
										})}
										value={entry.name}
									/>
								</div>
								<Button
									aria-label={
										entry.name
											? tl("Remove {name}", { name: entry.name })
											: tl("Remove schedule {number}", {
													number: String(index + 1),
												})
									}
									disabled={disabled}
									onClick={() =>
										onChange(
											schedules.filter(
												(_, currentIndex) => currentIndex !== index
											)
										)
									}
									size="icon-sm"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={Delete01Icon} />
								</Button>
							</div>

							<div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_1fr]">
								<div>
									<Label htmlFor={`agent-schedule-kind-${entry.id}`}>
										Frequency type
									</Label>
									<NativeSelect
										className="mt-1.5 w-full"
										disabled={disabled}
										id={`agent-schedule-kind-${entry.id}`}
										onChange={(event) =>
											updateSchedule(
												index,
												/* SAFETY: This authored NativeSelect offers only the cron and every schedule kinds. This is a native UI selection, not a decoder for arbitrary synthetic events. */ event
													.target.value as "cron" | "every"
											)
										}
										value={entry.schedule.kind}
									>
										<NativeSelectOption value="every">
											Every interval
										</NativeSelectOption>
										<NativeSelectOption value="cron">
											Cron expression
										</NativeSelectOption>
									</NativeSelect>
								</div>
								<div>
									<Label htmlFor={`agent-schedule-value-${entry.id}`}>
										{entry.schedule.kind === "cron"
											? "Cron (UTC unless zone is set)"
											: "Interval"}
									</Label>
									<Input
										className="mt-1.5"
										disabled={disabled}
										id={`agent-schedule-value-${entry.id}`}
										onChange={(event) => {
											const value = event.target.value;
											if (entry.schedule.kind === "cron") {
												update(index, {
													schedule: { ...entry.schedule, expr: value },
												});
											} else {
												update(index, {
													schedule: { kind: "every", interval: value },
												});
											}
										}}
										placeholder={
											entry.schedule.kind === "cron" ? "0 9 * * 1-5" : "1h"
										}
										value={scheduleValue(entry.schedule)}
										variant="code"
									/>
								</div>
							</div>

							{entry.schedule.kind === "cron" ? (
								<div>
									<Label htmlFor={`agent-schedule-tz-${entry.id}`}>
										Time zone (optional)
									</Label>
									<Input
										className="mt-1.5"
										disabled={disabled}
										id={`agent-schedule-tz-${entry.id}`}
										onChange={(event) => {
											if (entry.schedule.kind !== "cron") {
												return;
											}
											update(index, {
												schedule: {
													kind: "cron",
													expr: entry.schedule.expr,
													tz: event.target.value || null,
												},
											});
										}}
										placeholder="UTC"
										value={entry.schedule.tz ?? ""}
									/>
								</div>
							) : null}

							<div>
								<Label htmlFor={`agent-schedule-instructions-${entry.id}`}>
									Custom instructions
								</Label>
								<Textarea
									className="mt-1.5"
									disabled={disabled}
									id={`agent-schedule-instructions-${entry.id}`}
									onChange={(event) =>
										update(index, { instructions: event.target.value })
									}
									placeholder="What should this run do?"
									rows={3}
									value={entry.instructions}
								/>
							</div>

							<div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-3">
								<label
									className="flex items-center gap-2 text-sm"
									htmlFor={`agent-schedule-enabled-${entry.id}`}
								>
									<Switch
										checked={entry.enabled}
										disabled={disabled}
										id={`agent-schedule-enabled-${entry.id}`}
										onCheckedChange={(enabled) => update(index, { enabled })}
									/>
									Enabled
								</label>
								<div className="flex items-start gap-2 text-sm">
									<Switch
										checked={entry.requireApproval}
										disabled={disabled}
										id={`agent-schedule-approval-${entry.id}`}
										onCheckedChange={(requireApproval) =>
											update(index, { requireApproval })
										}
									/>
									<div className="flex flex-col gap-0.5">
										<label htmlFor={`agent-schedule-approval-${entry.id}`}>
											Ask before each run
										</label>
										<p className="text-muted-foreground text-xs">
											The run waits in your Inbox until you approve it.
										</p>
									</div>
								</div>
								<Badge className="ml-auto" variant="secondary">
									{entry.schedule.kind === "cron" ? "Cron" : "Interval"}
								</Badge>
							</div>
						</SettingsCard>
					))}
		</SettingsSection>
	);
}
