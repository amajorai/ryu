"use client";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { Textarea } from "@ryu/ui/components/textarea";
import type { Dispatch, SetStateAction } from "react";
import {
	DM_POLICIES,
	DM_POLICY_LABELS,
	dmPolicyInputSchema,
	GROUP_POLICIES,
	GROUP_POLICY_LABELS,
	GROUP_REPLY_LABELS,
	GROUP_REPLY_MODES,
	groupPolicyInputSchema,
	groupReplyModeInputSchema,
} from "./channels-constants.ts";
import {
	type AgentOption,
	DEFAULT_AGENT,
	type FormState,
	TEAM_PREFIX,
} from "./channels-model.ts";

interface ChannelRoutingSectionProps {
	agents: AgentOption[];
	form: FormState;
	setForm: Dispatch<SetStateAction<FormState>>;
	teams: AgentOption[];
}

export function ChannelRoutingSection({
	agents,
	form,
	setForm,
	teams,
}: ChannelRoutingSectionProps) {
	return (
		<>
			{/* Routing: a single agent, or a team whose lead agent
						    orchestrates and calls the other members. */}
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
						<optgroup label="Teams">
							{teams.map((t) => (
								<NativeSelectOption key={t.id} value={`${TEAM_PREFIX}${t.id}`}>
									{t.name}
								</NativeSelectOption>
							))}
						</optgroup>
					) : null}
				</NativeSelect>
				<p className="text-muted-foreground text-xs">
					Pick a single agent, or a team — the team's lead agent orchestrates
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
							groupReplyMode: groupReplyModeInputSchema.parse(e.target.value),
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
				<p className="text-muted-foreground text-xs">
					In group chats the bot auto-detects when it's addressed. Choose
					whether it replies only when @mentioned (or replied to) or to every
					message. Direct messages always get a reply.
				</p>
			</div>
		</>
	);
}

interface ChannelAccessSectionProps {
	form: FormState;
	setForm: Dispatch<SetStateAction<FormState>>;
}

export function ChannelAccessSection({
	form,
	setForm,
}: ChannelAccessSectionProps) {
	return (
		<div className="space-y-3 rounded-lg border bg-card p-4">
			<div>
				<p className="font-medium text-sm">Who can talk to it</p>
				<p className="text-muted-foreground text-xs">
					A bot token lets anyone who finds the bot spend your completions, so
					inbound is closed to strangers by default.
				</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="channel-dm-policy">Direct messages</Label>
				<NativeSelect
					id="channel-dm-policy"
					onChange={(e) =>
						setForm((f) => ({
							...f,
							dmPolicy: dmPolicyInputSchema.parse(e.target.value),
						}))
					}
					value={form.dmPolicy}
				>
					{DM_POLICIES.map((policy) => (
						<NativeSelectOption key={policy} value={policy}>
							{DM_POLICY_LABELS[policy]}
						</NativeSelectOption>
					))}
				</NativeSelect>
				{form.dmPolicy === "pairing" ? (
					<p className="text-muted-foreground text-xs">
						A new person gets a one-time code and is held until you approve it,
						so they can ask for access themselves instead of you hunting for
						their id.
					</p>
				) : null}
				{form.dmPolicy === "open" ? (
					<p className="text-status-destructive text-xs">
						Every direct message will be answered and billed to you.
					</p>
				) : null}
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="channel-group-policy">Groups</Label>
				<NativeSelect
					id="channel-group-policy"
					onChange={(e) =>
						setForm((f) => ({
							...f,
							groupPolicy: groupPolicyInputSchema.parse(e.target.value),
						}))
					}
					value={form.groupPolicy}
				>
					{GROUP_POLICIES.map((policy) => (
						<NativeSelectOption key={policy} value={policy}>
							{GROUP_POLICY_LABELS[policy]}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<p className="text-muted-foreground text-xs">
					There is no pairing flow for a group — one member typing at the bot is
					not consent from the whole room.
				</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="channel-group-allowlist">Allowed group/chat IDs</Label>
				<Input
					id="channel-group-allowlist"
					onChange={(e) =>
						setForm((f) => ({
							...f,
							groupAllowlist: e.target.value
								.split(",")
								.map((value) => value.trim())
								.filter(Boolean),
						}))
					}
					placeholder="room-id-1, room-id-2"
					value={form.groupAllowlist.join(", ")}
				/>
				<p className="text-muted-foreground text-xs">
					Used when Groups is set to the allowlist policy. Discord's watched
					channels are admitted automatically as well.
				</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="channel-group-user-allowlist">
					Allowed group sender IDs
				</Label>
				<Input
					id="channel-group-user-allowlist"
					onChange={(e) =>
						setForm((f) => ({
							...f,
							groupUserAllowlist: e.target.value
								.split(",")
								.map((value) => value.trim())
								.filter(Boolean),
						}))
					}
					placeholder="user-id-1, user-id-2"
					value={form.groupUserAllowlist.join(", ")}
				/>
				<p className="text-muted-foreground text-xs">
					Optional sender-level exception for Telegram, Slack, Discord, and
					BlueBubbles groups.
				</p>
			</div>
		</div>
	);
}
