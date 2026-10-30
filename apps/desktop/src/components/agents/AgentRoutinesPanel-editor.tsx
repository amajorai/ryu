import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type { EditorMode, RoutineDraft } from "./AgentRoutinesPanel-model.ts";

export function RoutineEditor({
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
										scheduleKind:
											/* SAFETY: This authored NativeSelect offers only the cron and every schedule kinds. This is a native UI selection, not a decoder for arbitrary synthetic events. */ event
												.target.value as "cron" | "every",
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
								disabled={disabled || saving}
								id="agent-routine-schedule-value"
								onChange={(event) =>
									onChange({ scheduleValue: event.target.value })
								}
								placeholder={
									draft.scheduleKind === "cron" ? "0 9 * * 1-5" : "1h"
								}
								value={draft.scheduleValue}
								variant="code"
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
									destination:
										/* SAFETY: This authored NativeSelect offers only new and existing transcript destinations. This is a native UI selection, not a decoder for arbitrary synthetic events. */ event
											.target.value as "new" | "existing",
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
									<>
										<NativeSelectOption value="">
											Choose a chat
										</NativeSelectOption>
										{conversations.map((conversation) => (
											<NativeSelectOption
												key={conversation.id}
												value={conversation.id}
											>
												{conversation.title || "Untitled chat"}
											</NativeSelectOption>
										))}
									</>
								)}
							</NativeSelect>
						</div>
					) : null}

					<div className="flex flex-col gap-3 border-border border-t pt-3">
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

					{error ? <ErrorLine message={error} /> : null}
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
