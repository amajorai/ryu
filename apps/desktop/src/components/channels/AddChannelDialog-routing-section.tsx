import type { AgentOption } from "@ryu/blocks/desktop/channels.tsx";
import {
	GROUP_REPLY_LABELS,
	GROUP_REPLY_MODES,
	type GroupReplyMode,
} from "@ryu/blocks/desktop/channels.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	DEFAULT_AGENT,
	type FormState,
	type SetFormState,
	TEAM_PREFIX,
} from "./AddChannelDialog-form.ts";

/** Routing, model, system prompt and group-reply fields of the new-channel form. */
export function AddChannelRoutingSection({
	form,
	setForm,
	agents,
	teams,
}: {
	form: FormState;
	setForm: SetFormState;
	agents: AgentOption[];
	teams: AgentOption[];
}) {
	return (
		<>
			<div className="space-y-1.5">
				<Label htmlFor="channel-agent">Routes to</Label>
				<NativeSelect
					id="channel-agent"
					onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
					value={form.agentId}
				>
					<NativeSelectOption value={DEFAULT_AGENT}>
						Default agent
					</NativeSelectOption>
					{agents.length > 0 ? (
						<optgroup label="Agents">
							{agents.map((a) => (
								<NativeSelectOption key={a.id} value={a.id}>
									{a.name}
								</NativeSelectOption>
							))}
						</optgroup>
					) : null}
					{teams.length > 0 ? (
						<optgroup label="Groups">
							{teams.map((t) => (
								<NativeSelectOption key={t.id} value={`${TEAM_PREFIX}${t.id}`}>
									{t.name}
								</NativeSelectOption>
							))}
						</optgroup>
					) : null}
				</NativeSelect>
				<p className="text-detail text-muted-foreground">
					Pick a single agent, or a group — the group's lead agent orchestrates
					and calls the other members to answer.
				</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="channel-model">Model override (optional)</Label>
				<Input
					id="channel-model"
					onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
					placeholder="Leave blank to use the agent's model"
					value={form.model}
				/>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="channel-prompt">System prompt (optional)</Label>
				<Textarea
					id="channel-prompt"
					onChange={(e) =>
						setForm((f) => ({ ...f, systemPrompt: e.target.value }))
					}
					placeholder="Override the agent's persona for this bot"
					rows={3}
					value={form.systemPrompt}
				/>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="channel-group-reply">Group replies</Label>
				<NativeSelect
					id="channel-group-reply"
					onChange={(e) =>
						setForm((f) => ({
							...f,
							groupReplyMode:
								/* SAFETY: This NativeSelect renders only the typed GROUP_REPLY_MODES option values. This is a native UI selection, not a decoder for arbitrary synthetic events. */ e
									.target.value as GroupReplyMode,
						}))
					}
					value={form.groupReplyMode}
				>
					{GROUP_REPLY_MODES.map((mode) => (
						<NativeSelectOption key={mode} value={mode}>
							{GROUP_REPLY_LABELS[mode]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
		</>
	);
}
