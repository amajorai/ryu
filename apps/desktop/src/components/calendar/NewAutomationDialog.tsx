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
import { Switch } from "@ryu/ui/components/switch";
import { useMemo, useState } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createScheduledAgentWorkflow,
	phraseToSchedule,
	type SchedulePhrase,
} from "@/src/lib/automations.ts";

const PHRASE_OPTIONS: { value: SchedulePhrase; label: string }[] = [
	{ value: "hourly", label: "Every hour" },
	{ value: "daily", label: "Daily" },
	{ value: "weekdays", label: "Weekdays" },
	{ value: "weekends", label: "Weekends" },
	{ value: "weekly", label: "Weekly" },
	{ value: "everyminute", label: "Every minute" },
	{ value: "custom", label: "Custom cron" },
];

const WEEKDAY_OPTIONS = [
	{ value: "monday", label: "Monday" },
	{ value: "tuesday", label: "Tuesday" },
	{ value: "wednesday", label: "Wednesday" },
	{ value: "thursday", label: "Thursday" },
	{ value: "friday", label: "Friday" },
	{ value: "saturday", label: "Saturday" },
	{ value: "sunday", label: "Sunday" },
];

export function NewAutomationDialog({
	open,
	onOpenChange,
	onCreated,
	defaultAgentId,
	defaultConversationId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: () => void;
	defaultAgentId?: string;
	defaultConversationId?: string;
}) {
	const activeNode = useActiveNode();
	const { agents } = useAgents();
	const { conversations } = useChatHistoryContext();
	const activeAgents = useMemo(
		() => agents.filter((agent) => agent.lifecycleStatus === "active"),
		[agents]
	);

	const [agentId, setAgentId] = useState(defaultAgentId ?? "");
	const [phrase, setPhrase] = useState<SchedulePhrase>("daily");
	const [dailyTime, setDailyTime] = useState("09:00");
	const [weeklyDay, setWeeklyDay] = useState("monday");
	const [weeklyTime, setWeeklyTime] = useState("09:00");
	const [customCron, setCustomCron] = useState("");
	const [destination, setDestination] = useState<"new" | "existing">(
		defaultConversationId ? "existing" : "new"
	);
	const [conversationId, setConversationId] = useState(
		defaultConversationId ?? ""
	);
	const [requireApproval, setRequireApproval] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Default the agent picker to the first agent once the list loads.
	const selectedAgentId = activeAgents.some((agent) => agent.id === agentId)
		? agentId
		: (activeAgents[0]?.id ?? "");
	const agentConversations = useMemo(
		() =>
			conversations
				.filter((conversation) => conversation.agentId === selectedAgentId)
				.sort((a, b) => b.updatedAt - a.updatedAt),
		[selectedAgentId, conversations]
	);
	const currentConversation = agentConversations.find(
		(conversation) => conversation.id === defaultConversationId
	);
	const orderedConversations = currentConversation
		? [
				currentConversation,
				...agentConversations.filter(
					(conversation) => conversation.id !== currentConversation.id
				),
			]
		: agentConversations;

	const handleAgentChange = (nextAgentId: string) => {
		setAgentId(nextAgentId);
		if (destination !== "existing") {
			return;
		}
		const selectedConversation = conversations.find(
			(conversation) =>
				conversation.id === conversationId &&
				conversation.agentId === nextAgentId
		);
		if (!selectedConversation) {
			setConversationId(
				conversations.find(
					(conversation) => conversation.agentId === nextAgentId
				)?.id ?? ""
			);
		}
	};

	const handleDestinationChange = (nextDestination: "new" | "existing") => {
		setDestination(nextDestination);
		if (nextDestination === "existing" && !conversationId) {
			setConversationId(agentConversations[0]?.id ?? "");
		}
	};

	const handleCreate = async () => {
		const agent = activeAgents.find((a) => a.id === selectedAgentId);
		if (!agent) {
			setError("Pick an agent to schedule.");
			return;
		}
		if (phrase === "custom" && customCron.trim().length === 0) {
			setError("Enter a cron expression.");
			return;
		}
		if (destination === "existing" && !conversationId) {
			setError("Choose a persistent chat.");
			return;
		}
		setSaving(true);
		setError(null);
		const target: ApiTarget = {
			url: activeNode.url,
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
		};
		try {
			await createScheduledAgentWorkflow(target, {
				agentId: agent.id,
				agentName: agent.name,
				conversationId: destination === "existing" ? conversationId : null,
				schedule: phraseToSchedule(
					phrase,
					dailyTime,
					weeklyDay,
					weeklyTime,
					customCron
				),
				requireApproval,
			});
			onCreated();
			onOpenChange(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to create automation");
		} finally {
			setSaving(false);
		}
	};

	const showDailyTime =
		phrase === "daily" || phrase === "weekdays" || phrase === "weekends";

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New automation</DialogTitle>
					<DialogDescription>
						Run an agent automatically on a durable routine. Its result appears
						in the agent's routine and run-history views.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-1">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="automation-agent">Agent</Label>
						<NativeSelect
							className="w-full"
							id="automation-agent"
							onChange={(e) => handleAgentChange(e.target.value)}
							value={selectedAgentId}
						>
							{activeAgents.length === 0 ? (
								<NativeSelectOption disabled value="">
									No agents available
								</NativeSelectOption>
							) : (
								activeAgents.map((a) => (
									<NativeSelectOption key={a.id} value={a.id}>
										{a.name}
									</NativeSelectOption>
								))
							)}
						</NativeSelect>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="automation-schedule">Schedule</Label>
						<NativeSelect
							className="w-full"
							id="automation-schedule"
							onChange={(e) => setPhrase(e.target.value as SchedulePhrase)}
							value={phrase}
						>
							{PHRASE_OPTIONS.map((o) => (
								<NativeSelectOption key={o.value} value={o.value}>
									{o.label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>

					{showDailyTime && (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="automation-daily-time">Time (UTC)</Label>
							<Input
								id="automation-daily-time"
								onChange={(e) => setDailyTime(e.target.value)}
								type="time"
								value={dailyTime}
							/>
						</div>
					)}

					{phrase === "weekly" && (
						<div className="flex gap-3">
							<div className="flex flex-1 flex-col gap-1.5">
								<Label htmlFor="automation-weekly-day">Day</Label>
								<NativeSelect
									className="w-full"
									id="automation-weekly-day"
									onChange={(e) => setWeeklyDay(e.target.value)}
									value={weeklyDay}
								>
									{WEEKDAY_OPTIONS.map((o) => (
										<NativeSelectOption key={o.value} value={o.value}>
											{o.label}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</div>
							<div className="flex flex-1 flex-col gap-1.5">
								<Label htmlFor="automation-weekly-time">Time (UTC)</Label>
								<Input
									id="automation-weekly-time"
									onChange={(e) => setWeeklyTime(e.target.value)}
									type="time"
									value={weeklyTime}
								/>
							</div>
						</div>
					)}

					{phrase === "custom" && (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="automation-cron">Cron expression (UTC)</Label>
							<Input
								id="automation-cron"
								onChange={(e) => setCustomCron(e.target.value)}
								placeholder="0 9 * * *"
								value={customCron}
							/>
						</div>
					)}

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="automation-destination">
							Transcript destination
						</Label>
						<NativeSelect
							className="w-full"
							id="automation-destination"
							onChange={(e) =>
								handleDestinationChange(e.target.value as "new" | "existing")
							}
							value={destination}
						>
							<NativeSelectOption value="new">
								New chat each run
							</NativeSelectOption>
							<NativeSelectOption value="existing">
								Keep one persistent chat
							</NativeSelectOption>
						</NativeSelect>
						<p className="text-muted-foreground text-xs">
							{destination === "existing"
								? defaultConversationId === conversationId
									? "This schedule will keep appending to the chat you started from."
									: "Every firing appends to the selected chat."
								: "Each firing gets a clean durable transcript you can open from history."}
						</p>
					</div>

					{destination === "existing" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="automation-chat">Persistent chat</Label>
							<NativeSelect
								className="w-full"
								disabled={orderedConversations.length === 0}
								id="automation-chat"
								onChange={(e) => setConversationId(e.target.value)}
								value={conversationId}
							>
								{orderedConversations.length === 0 ? (
									<NativeSelectOption value="">
										No agent chats yet
									</NativeSelectOption>
								) : (
									orderedConversations.map((conversation) => (
										<NativeSelectOption
											key={conversation.id}
											value={conversation.id}
										>
											{conversation.id === defaultConversationId
												? "Current chat · "
												: ""}
											{conversation.title || "Untitled chat"}
										</NativeSelectOption>
									))
								)}
							</NativeSelect>
						</div>
					) : null}

					<div className="flex items-start justify-between gap-3 rounded-lg border p-3">
						<div className="flex flex-col gap-0.5">
							<Label htmlFor="automation-require-approval">
								Ask before each run
							</Label>
							<p className="text-muted-foreground text-xs">
								The run waits in your Inbox until you approve it. It will not
								open a blocking dialog when the schedule fires.
							</p>
						</div>
						<Switch
							checked={requireApproval}
							id="automation-require-approval"
							onCheckedChange={setRequireApproval}
						/>
					</div>

					{error && <p className="text-destructive text-sm">{error}</p>}
				</div>

				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => onOpenChange(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={saving || agents.length === 0}
						onClick={() => {
							handleCreate().catch(() => undefined);
						}}
					>
						{saving ? "Creating…" : "Create automation"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
