"use client";

import {
	Add01Icon,
	Clock01Icon,
	Delete01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { formatMessage } from "@ryu/i18n/core";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Switch } from "@ryu/ui/components/switch";
import type {
	AgentSettingsFormProps,
	ComposioAccountOption,
} from "./agent-edit-form-types.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";

const WEEKDAYS = [
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
	"sunday",
];

const SCHEDULE_PHRASE_ITEMS = [
	{ value: "everyminute", label: "Every minute" },
	{ value: "hourly", label: "Every hour" },
	{ value: "daily", label: "Every day at…" },
	{ value: "weekdays", label: "Weekdays at…" },
	{ value: "weekends", label: "Weekends at…" },
	{ value: "weekly", label: "Every week on…" },
	{ value: "custom", label: "Custom cron" },
];

/** English formatting for callers outside a React tree (tests, plain code). */
const englishLiteral: LiteralMessage = (source, values) =>
	formatMessage(source, values);

/** The picker label of a trigger account, naming whose account it is when the
 *  agent may watch both kinds. */
export function triggerAccountLabel(
	account: ComposioAccountOption,
	tl: LiteralMessage = englishLiteral
): string {
	if (account.owner === "agent") {
		return tl("This agent's account · {label}", { label: account.label });
	}
	if (account.owner === "you") {
		return tl("Your account · {label}", { label: account.label });
	}
	return account.label;
}

/** Triggers tab: the schedule (or injected routines) plus Composio event
 *  triggers. */
export function AgentTriggersPanel({
	accountAccessPath,
	props,
}: {
	accountAccessPath: string;
	props: AgentSettingsFormProps;
}) {
	const {
		isLocked,
		composioToolkit,
		routinesPanel,
		composioAccounts,
		scheduleEnabled,
		onScheduleEnabledChange,
		schedulePhrase,
		onSchedulePhraseChange,
		dailyTime,
		onDailyTimeChange,
		weeklyDay,
		onWeeklyDayChange,
		weeklyTime,
		onWeeklyTimeChange,
		customCron,
		onCustomCronChange,
		showComposioTriggers,
		triggerSubs,
		onDeleteTrigger,
		composioTriggers,
		triggerSlug,
		onTriggerSlugChange,
		connectedAccountId,
		onConnectedAccountIdChange,
		subscribing,
		triggerError,
		onSubscribeTrigger,
		ownAccountsAllowed = false,
	} = props;
	const tl = useLiteralMessages();
	const showTimeField =
		schedulePhrase === "daily" ||
		schedulePhrase === "weekdays" ||
		schedulePhrase === "weekends";

	// Accounts the trigger picker offers: those for the integration picked under
	// Connections. Toolkit slugs compare case-insensitively, as Core keys them.
	const triggerToolkit = composioToolkit?.toLowerCase() ?? "";
	const triggerAccounts = (composioAccounts ?? []).filter(
		(account) => account.toolkit.toLowerCase() === triggerToolkit
	);

	return (
		<>
			{/* 3. Trigger — schedule + Composio event triggers */}
			{routinesPanel ?? (
				<SettingsSection
					caption="Run this agent automatically on a schedule."
					title="Schedule"
				>
					<SettingsGroup>
						<SettingsItem
							actions={
								<Switch
									checked={scheduleEnabled}
									disabled={isLocked}
									id="schedule-toggle"
									onCheckedChange={onScheduleEnabledChange}
								/>
							}
							title="Run on a schedule"
						/>
						{scheduleEnabled ? (
							<SettingsItem
								actions={
									<Select
										disabled={isLocked}
										items={SCHEDULE_PHRASE_ITEMS}
										onValueChange={(v) => onSchedulePhraseChange?.(v ?? "")}
										value={schedulePhrase}
									>
										<SelectTrigger
											appearance="editor-row"
											className="w-44 shrink-0"
											id="schedule-phrase"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{SCHEDULE_PHRASE_ITEMS.map((opt) => (
												<SelectItem key={opt.value} value={opt.value}>
													{opt.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								}
								title="Frequency"
							/>
						) : null}
						{scheduleEnabled && showTimeField ? (
							<SettingsItem
								actions={
									<Input
										aria-label="Time"
										className="h-8 w-32"
										disabled={isLocked}
										id="daily-time"
										onChange={(e) => onDailyTimeChange?.(e.target.value)}
										type="time"
										value={dailyTime}
									/>
								}
								title="Time"
							/>
						) : null}
						{scheduleEnabled && schedulePhrase === "weekly" ? (
							<SettingsItem
								actions={
									<Select
										disabled={isLocked}
										items={WEEKDAYS.map((d) => ({
											value: d,
											label: d.charAt(0).toUpperCase() + d.slice(1),
										}))}
										onValueChange={(v) => onWeeklyDayChange?.(v ?? "")}
										value={weeklyDay}
									>
										<SelectTrigger
											appearance="editor-row"
											className="w-36 shrink-0"
											id="weekly-day"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{WEEKDAYS.map((d) => (
												<SelectItem key={d} value={d}>
													{d.charAt(0).toUpperCase() + d.slice(1)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								}
								title="Day"
							/>
						) : null}
						{scheduleEnabled && schedulePhrase === "weekly" ? (
							<SettingsItem
								actions={
									<Input
										aria-label="Time"
										className="h-8 w-32"
										disabled={isLocked}
										id="weekly-time"
										onChange={(e) => onWeeklyTimeChange?.(e.target.value)}
										type="time"
										value={weeklyTime}
									/>
								}
								title="Time"
							/>
						) : null}
						{scheduleEnabled && schedulePhrase === "custom" ? (
							<SettingsItem
								actions={
									<Input
										aria-label="Cron expression"
										className="w-44"
										disabled={isLocked}
										id="custom-cron"
										onChange={(e) => onCustomCronChange?.(e.target.value)}
										placeholder="e.g. 0 9 * * 1-5"
										size="agent-row"
										value={customCron}
										variant="code"
									/>
								}
								description="Standard 5-field cron: minute hour day month weekday."
								title="Cron expression"
							/>
						) : null}
					</SettingsGroup>
				</SettingsSection>
			)}

			{showComposioTriggers ? (
				<SettingsSection
					caption="Choose exact connected-app events to watch. Ryu redacts likely secrets, then the node's default model uses these instructions to decide whether to show a private Island suggestion. For channel messages or actions, bind the event to an explicit workflow. Trigger checks cannot use tools."
					title="Event triggers"
				>
					<SettingsCard className="flex flex-col gap-3">
						{triggerSubs.length > 0 ? (
							<div className="flex flex-col gap-1.5">
								{triggerSubs.map((sub) => (
									<div className="flex items-center gap-2 text-sm" key={sub.id}>
										<HugeiconsIcon
											className="size-3.5 text-muted-foreground"
											icon={Clock01Icon}
										/>
										<span className="min-w-0 flex-1 truncate">
											{sub.triggerSlug}
											<span className="text-muted-foreground text-xs">
												{" "}
												({sub.toolkit})
											</span>
										</span>
										{sub.ownAccount ? (
											<Badge variant="secondary">Its own account</Badge>
										) : null}
										{sub.paused ? (
											<Badge variant="outline">
												Paused: account not allowed
											</Badge>
										) : null}
										<Button
											aria-label="Remove trigger"
											onClick={() => onDeleteTrigger?.(sub.id)}
											size="icon-sm"
											variant="ghost"
										>
											<HugeiconsIcon className="size-4" icon={Delete01Icon} />
										</Button>
									</div>
								))}
							</div>
						) : null}

						{composioToolkit ? (
							<>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="composio-trigger">Trigger event</Label>
									<Select
										disabled={isLocked}
										items={composioTriggers.map((t) => ({
											value: t.name,
											label: t.displayName,
										}))}
										onValueChange={(v) => onTriggerSlugChange?.(v ?? "")}
										value={triggerSlug}
									>
										<SelectTrigger className="w-full" id="composio-trigger">
											<SelectValue placeholder="Pick a trigger event" />
										</SelectTrigger>
										<SelectContent>
											{composioTriggers.map((t) => (
												<SelectItem key={t.name} value={t.name}>
													{t.displayName}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="composio-account">Account to watch</Label>
									{composioAccounts ? (
										triggerAccounts.length > 0 ? (
											<Select
												disabled={isLocked}
												items={triggerAccounts.map((account) => ({
													value: account.id,
													label: triggerAccountLabel(account, tl),
												}))}
												onValueChange={(v) =>
													onConnectedAccountIdChange?.(v ?? "")
												}
												value={connectedAccountId}
											>
												<SelectTrigger className="w-full" id="composio-account">
													<SelectValue placeholder="Pick a connected account" />
												</SelectTrigger>
												<SelectContent>
													{triggerAccounts.map((account) => (
														<SelectItem key={account.id} value={account.id}>
															{triggerAccountLabel(account, tl)}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										) : (
											<p className="text-muted-foreground text-xs">
												{tl(
													"No connected {composioToolkit} account this agent may use. Connect one in Store → Connections{ownAccountsHint} or allow one under {accountAccessPath}.",
													{
														accountAccessPath,
														composioToolkit,
														ownAccountsHint: ownAccountsAllowed
															? tl(
																	", connect one for the agent under {accountAccessPath} → Agent's own accounts,",
																	{ accountAccessPath }
																)
															: "",
													}
												)}
											</p>
										)
									) : (
										<>
											<Input
												disabled={isLocked}
												id="composio-account"
												onChange={(e) =>
													onConnectedAccountIdChange?.(e.target.value)
												}
												placeholder="Paste the account id from your Composio dashboard"
												value={connectedAccountId}
											/>
											<p className="text-muted-foreground text-xs">
												The id of the connected account whose selected events
												this agent should watch. You'll find it in your Composio
												dashboard.
											</p>
										</>
									)}
								</div>
								{triggerError ? (
									<p className="text-status-destructive text-xs">
										{triggerError}
									</p>
								) : null}
								<Button
									className="self-start"
									disabled={isLocked}
									loading={subscribing}
									onClick={onSubscribeTrigger}
									size="sm"
									variant="outline"
								>
									{!subscribing && (
										<HugeiconsIcon className="size-4" icon={Add01Icon} />
									)}
									Add trigger
								</Button>
							</>
						) : (
							<p className="text-muted-foreground text-xs">
								Pick an integration under Connections first.
							</p>
						)}
					</SettingsCard>
				</SettingsSection>
			) : null}
		</>
	);
}
