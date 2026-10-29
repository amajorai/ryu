import type { AgentOption } from "@ryu/blocks/desktop/channels.tsx";
import {
	CHANNEL_LABELS,
	CHANNEL_SETUP,
	CHANNEL_TYPES,
	type ChannelType,
	DEFAULT_GROUP_REPLY_MODE,
	defaultReactionLearningSettings,
	GROUP_REPLY_LABELS,
	GROUP_REPLY_MODES,
	type GroupReplyMode,
	REQUIRED_SECRETS,
	type ReactionLearningSettings,
	SECRET_LABELS,
} from "@ryu/blocks/desktop/channels.tsx";
import { Alert, AlertDescription } from "@ryu/ui/components/alert.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { TelegramManagedBotPanel } from "@/src/components/channels/TelegramManagedBotPanel.tsx";
import { ScrollFadeEffect } from "@/src/components/ui/scroll-fade-effect.tsx";

const DEFAULT_AGENT = "__default__";
const TEAM_PREFIX = "team:";

/**
 * How the user supplies a Telegram bot. `managed` is the zero-token path (Ryu's
 * manager bot has Telegram create a bot the user owns — Bot API 9.6); `manual` is
 * the original paste-a-@BotFather-token form, kept as the fallback for every case
 * the managed path can't serve (support switched off server-side, an existing bot
 * the user wants to reuse).
 *
 * Only Telegram has two ways in; every other platform renders `manual` only.
 */
type ConnectMode = "managed" | "manual";

interface FormState {
	agentId: string;
	channelType: ChannelType;
	enabled: boolean;
	groupReplyMode: GroupReplyMode;
	model: string;
	name: string;
	proactiveOpening: boolean;
	proactiveTarget: string;
	reactionLearning: ReactionLearningSettings;
	secrets: Record<string, string>;
	systemPrompt: string;
}

/**
 * Split the single agent/team picker value into the two mutually-exclusive bindings
 * the server takes. Shared by the manual submit and the managed pairing, so a bot
 * created either way answers as the same thing.
 */
function splitBinding(value: string) {
	if (value.startsWith(TEAM_PREFIX)) {
		return { agentId: null, teamId: value.slice(TEAM_PREFIX.length) };
	}
	return {
		agentId: value === DEFAULT_AGENT ? null : value,
		teamId: null,
	};
}

function emptyForm(): FormState {
	return {
		channelType: "telegram",
		name: "",
		agentId: DEFAULT_AGENT,
		model: "",
		systemPrompt: "",
		groupReplyMode: DEFAULT_GROUP_REPLY_MODE,
		proactiveOpening: false,
		proactiveTarget: "",
		reactionLearning: defaultReactionLearningSettings(),
		enabled: false,
		secrets: {},
	};
}

export function AddChannelDialog({
	open,
	onOpenChange,
	agents = [],
	teams = [],
	onCreate,
	onNodeCreated,
	initialAgentId,
	initialAgentName,
	initialChannelType,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: AgentOption[];
	teams?: AgentOption[];
	/** Non-secret values supplied by the new-agent flow. */
	initialAgentId?: string;
	initialAgentName?: string;
	initialChannelType?: ChannelType;
	/**
	 * The NODE created the config itself. The managed-bot path writes it server-side
	 * (the pairing's claim secret has to be sealed into the row and must not pass
	 * through this webview), so `onCreate` never runs and the host has to be told
	 * some other way — without this the list never refetches and the dialog just
	 * vanishes with nothing to show for it.
	 */
	onNodeCreated?: (name: string) => void | Promise<void>;
	onCreate: (input: {
		channelType: ChannelType;
		name: string;
		secrets: Record<string, string>;
		agentId: string | null;
		teamId: string | null;
		groupReplyMode: GroupReplyMode;
		model: string | null;
		proactiveOpening: boolean;
		proactiveTarget: string | null;
		reactionLearning: ReactionLearningSettings;
		systemPrompt: string | null;
		enabled: boolean;
	}) => Promise<boolean>;
}) {
	const [form, setForm] = useState<FormState>(emptyForm);
	const [saving, setSaving] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [connectMode, setConnectMode] = useState<ConnectMode>("managed");
	/** Set when the node reports managed bots are unavailable, so the forced switch
	 *  to the manual fields comes with a reason instead of silently happening. */
	const [managedNotice, setManagedNotice] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		setForm((current) => ({
			...current,
			...(initialAgentId ? { agentId: initialAgentId } : undefined),
			...(initialAgentName ? { name: initialAgentName } : undefined),
			...(initialChannelType
				? { channelType: initialChannelType, secrets: {} }
				: undefined),
		}));
		if (initialChannelType) {
			setConnectMode(initialChannelType === "telegram" ? "managed" : "manual");
		}
	}, [open, initialAgentId, initialAgentName, initialChannelType]);

	const requiredKeys = REQUIRED_SECRETS[form.channelType];
	const setup = CHANNEL_SETUP[form.channelType];
	const managedAvailable = form.channelType === "telegram";
	const usingManaged = managedAvailable && connectMode === "managed";

	/**
	 * `secretsOverride` lets the managed path submit through this exact function
	 * rather than a parallel one: the token arrives from the pairing poll, not from
	 * form state, and merging it here means the required-key guard below validates
	 * what will actually be sent.
	 *
	 * Returns whether the channel was actually created, so the managed path can
	 * tell "saved and closed" from "still on screen with an error".
	 */
	const handleSave = useCallback(
		async (secretsOverride?: Record<string, string>): Promise<boolean> => {
			setFormError(null);
			if (!form.name.trim()) {
				setFormError("Name is required.");
				return false;
			}
			if (form.proactiveOpening && !form.proactiveTarget.trim()) {
				setFormError(
					"Choose the approved chat that should receive Ryu's welcome."
				);
				return false;
			}

			const { agentId, teamId } = splitBinding(form.agentId);

			const secrets: Record<string, string> = {};
			for (const [key, value] of Object.entries({
				...form.secrets,
				...secretsOverride,
			})) {
				if (value.trim()) {
					secrets[key] = value.trim();
				}
			}

			const missing = requiredKeys.filter((k) => !secrets[k]);
			if (missing.length > 0) {
				setFormError(
					`Missing required: ${missing
						.map((k) => SECRET_LABELS[k] ?? k)
						.join(", ")}`
				);
				return false;
			}

			setSaving(true);
			try {
				const ok = await onCreate({
					channelType: form.channelType,
					name: form.name.trim(),
					secrets,
					agentId,
					teamId,
					groupReplyMode: form.groupReplyMode,
					model: form.model.trim() || null,
					proactiveOpening: form.proactiveOpening,
					proactiveTarget: form.proactiveTarget.trim() || null,
					reactionLearning: form.reactionLearning,
					systemPrompt: form.systemPrompt.trim() || null,
					enabled: form.enabled,
				});
				if (ok) {
					setForm(emptyForm());
					setConnectMode("managed");
					setManagedNotice(null);
					onOpenChange(false);
				}
				return ok;
			} finally {
				setSaving(false);
			}
		},
		[form, requiredKeys, onCreate, onOpenChange]
	);

	/**
	 * What the pairing sends the node, at pairing time. It has to travel up front:
	 * the node writes the channel config when the token arrives, minutes after this
	 * dialog is gone, so a field not sent here is a user choice that quietly reverts
	 * to a server default.
	 */
	const managedForm = useMemo(() => {
		const { agentId, teamId } = splitBinding(form.agentId);
		return {
			agent_id: agentId,
			enabled: form.enabled,
			group_reply_mode: form.groupReplyMode,
			model: form.model.trim() || null,
			proactive_opening: form.proactiveOpening,
			proactive_target: form.proactiveTarget.trim() || null,
			reaction_learning: form.reactionLearning,
			system_prompt: form.systemPrompt.trim() || null,
			team_id: teamId,
		};
	}, [
		form.agentId,
		form.enabled,
		form.groupReplyMode,
		form.model,
		form.proactiveOpening,
		form.proactiveTarget,
		form.reactionLearning,
		form.systemPrompt,
	]);

	const handleDialogOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) {
			setForm(emptyForm());
			setConnectMode("managed");
			setManagedNotice(null);
		}
		onOpenChange(nextOpen);
	};

	/**
	 * The managed pairing finished. Two shapes are possible and both are terminal:
	 * the node handed the token back (submit it through the normal form path), or
	 * the node already wrote the channel row itself — the usual case — in which case
	 * there is nothing left to save and the host is told so it can refresh.
	 */
	const handleManagedReady = useCallback(
		(token: string | undefined) => {
			if (!token) {
				const created = form.name.trim();
				setForm(emptyForm());
				setConnectMode("managed");
				setManagedNotice(null);
				onOpenChange(false);
				// The node already carried the whole form, so there is nothing to
				// submit — but somebody still has to refetch the list and say it worked.
				void onNodeCreated?.(created);
				return;
			}
			// Park the token in the form as well as submitting it. Telegram has
			// already created a real bot at this point, so if the save fails (signed
			// out, control plane down) the user must not have to mint a second one —
			// dropping to the manual mode on failure surfaces the field that now
			// holds it, and "Create bot" retries with no further Telegram round trip.
			setForm((f) => ({
				...f,
				secrets: { ...f.secrets, bot_token: token },
			}));
			handleSave({ bot_token: token })
				.then((saved) => {
					if (!saved) {
						setConnectMode("manual");
					}
				})
				.catch(() => setConnectMode("manual"));
		},
		[form.name, handleSave, onNodeCreated, onOpenChange]
	);

	/** Managed bots are off server-side: drop to the manual fields with a reason. */
	const handleManagedUnsupported = useCallback((message: string) => {
		setManagedNotice(message);
		setConnectMode("manual");
	}, []);

	return (
		<Dialog onOpenChange={handleDialogOpenChange} open={open}>
			<DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>New channel bot</DialogTitle>
				</DialogHeader>

				<ScrollFadeEffect className="min-h-0 flex-1">
					<div className="space-y-4 pb-1">
						<div className="space-y-1.5">
							<Label htmlFor="channel-name">Name</Label>
							<Input
								id="channel-name"
								onChange={(e) =>
									setForm((f) => ({ ...f, name: e.target.value }))
								}
								placeholder="e.g. Support bot"
								value={form.name}
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="channel-type">Platform</Label>
							<NativeSelect
								id="channel-type"
								onChange={(e) => {
									// Switching platform already clears the secrets; the pairing
									// state is Telegram-only, so it has to go with them or the
									// panel would keep polling a nonce for a bot we no longer want.
									setConnectMode("managed");
									setManagedNotice(null);
									setForm((f) => ({
										...f,
										channelType:
											/* SAFETY: This NativeSelect renders only the typed CHANNEL_TYPES option values. This is a native UI selection, not a decoder for arbitrary synthetic events. */ e
												.target.value as ChannelType,
										secrets: {},
									}));
								}}
								value={form.channelType}
							>
								{CHANNEL_TYPES.map((t) => (
									<NativeSelectOption key={t} value={t}>
										{CHANNEL_LABELS[t]}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>

						<div className="space-y-3 rounded-lg border bg-card p-4">
							<p className="font-medium text-sm">Credentials</p>
							{managedAvailable ? (
								<div className="flex gap-2">
									<Button
										onClick={() => setConnectMode("managed")}
										size="sm"
										variant={usingManaged ? "default" : "outline"}
									>
										Create a bot for me
									</Button>
									<Button
										onClick={() => setConnectMode("manual")}
										size="sm"
										variant={usingManaged ? "outline" : "default"}
									>
										Paste a token
									</Button>
								</div>
							) : null}
							{managedNotice ? (
								<p className="text-muted-foreground text-xs">
									{managedNotice} Create one with @BotFather and paste its token
									below instead.
								</p>
							) : null}
							{usingManaged ? (
								<TelegramManagedBotPanel
									active={open && usingManaged}
									botName={form.name}
									form={managedForm}
									onReady={handleManagedReady}
									onUnsupported={handleManagedUnsupported}
								/>
							) : null}
							{usingManaged ? null : (
								<p className="text-muted-foreground text-xs">{setup.note}</p>
							)}
							{(usingManaged ? [] : requiredKeys).map((key) => {
								const help = setup.secretHelp[key];
								return (
									<div className="space-y-1.5" key={key}>
										<Label htmlFor={`dialog-secret-${key}`}>
											{SECRET_LABELS[key] ?? key}
										</Label>
										<Input
											aria-describedby={
												help ? `dialog-secret-${key}-help` : undefined
											}
											autoComplete="off"
											id={`dialog-secret-${key}`}
											name={`dialog-secret-${key}`}
											onChange={(e) =>
												setForm((f) => ({
													...f,
													secrets: { ...f.secrets, [key]: e.target.value },
												}))
											}
											placeholder="Paste value…"
											type={
												key === "openwa_url" || key === "webhook_url"
													? "url"
													: "password"
											}
											value={form.secrets[key] ?? ""}
										/>
										{help ? (
											<p
												className="text-muted-foreground text-xs"
												id={`dialog-secret-${key}-help`}
											>
												{help}
											</p>
										) : null}
									</div>
								);
							})}
							<p className="text-muted-foreground text-xs">
								Values are stored encrypted and never shown again.
							</p>
						</div>
						{setup.warning ? (
							<Alert>
								<AlertDescription>{setup.warning}</AlertDescription>
							</Alert>
						) : null}

						<div className="space-y-1.5">
							<Label htmlFor="channel-agent">Routes to</Label>
							<NativeSelect
								id="channel-agent"
								onChange={(e) =>
									setForm((f) => ({ ...f, agentId: e.target.value }))
								}
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
											<NativeSelectOption
												key={t.id}
												value={`${TEAM_PREFIX}${t.id}`}
											>
												{t.name}
											</NativeSelectOption>
										))}
									</optgroup>
								) : null}
							</NativeSelect>
							<p className="text-muted-foreground text-xs">
								Pick a single agent, or a group — the group's lead agent
								orchestrates and calls the other members to answer.
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="channel-model">Model override (optional)</Label>
							<Input
								id="channel-model"
								onChange={(e) =>
									setForm((f) => ({ ...f, model: e.target.value }))
								}
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

						{form.channelType === "telegram" ? (
							<div className="space-y-3 rounded-lg border bg-card p-4">
								<div className="flex items-center justify-between gap-4">
									<div>
										<p className="font-medium text-sm">Reaction learning</p>
										<p className="text-muted-foreground text-xs">
											Use reactions on this bot's replies as Good response / Bad
											response feedback. Off by default.
										</p>
									</div>
									<Switch
										aria-label="Enable reaction learning"
										checked={form.reactionLearning.enabled}
										onCheckedChange={(v) =>
											setForm((f) => ({
												...f,
												reactionLearning: { ...f.reactionLearning, enabled: v },
											}))
										}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="channel-add-positive-emojis">
										Good response emojis
									</Label>
									<Input
										disabled={!form.reactionLearning.enabled}
										id="channel-add-positive-emojis"
										onChange={(e) =>
											setForm((f) => ({
												...f,
												reactionLearning: {
													...f.reactionLearning,
													positiveEmoji: e.target.value
														.split(",")
														.map((value) => value.trim())
														.filter(Boolean),
												},
											}))
										}
										placeholder="👍, ❤️, 🎉"
										value={form.reactionLearning.positiveEmoji.join(", ")}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="channel-add-negative-emojis">
										Bad response emojis
									</Label>
									<Input
										disabled={!form.reactionLearning.enabled}
										id="channel-add-negative-emojis"
										onChange={(e) =>
											setForm((f) => ({
												...f,
												reactionLearning: {
													...f.reactionLearning,
													negativeEmoji: e.target.value
														.split(",")
														.map((value) => value.trim())
														.filter(Boolean),
												},
											}))
										}
										placeholder="👎, 💀, 😴"
										value={form.reactionLearning.negativeEmoji.join(", ")}
									/>
								</div>
								<div className="flex items-center justify-between gap-4">
									<div>
										<p className="text-sm">Allow group reactions</p>
										<p className="text-muted-foreground text-xs">
											Off by default because group feedback can represent more
											than one person.
										</p>
									</div>
									<Switch
										aria-label="Allow group reaction learning"
										checked={form.reactionLearning.allowGroup}
										disabled={!form.reactionLearning.enabled}
										onCheckedChange={(v) =>
											setForm((f) => ({
												...f,
												reactionLearning: {
													...f.reactionLearning,
													allowGroup: v,
												},
											}))
										}
									/>
								</div>
							</div>
						) : null}

						<div className="space-y-3 rounded-lg border bg-card p-4">
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="font-medium text-sm">Say hello first</p>
									<p className="text-muted-foreground text-xs">
										When this bot starts, Ryu sends one welcome message while it
										waits for you to write first.
									</p>
								</div>
								<Switch
									aria-label="Let Ryu say hello first"
									checked={form.proactiveOpening}
									onCheckedChange={(v) =>
										setForm((f) => ({ ...f, proactiveOpening: v }))
									}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="channel-proactive-target">
									Where should Ryu say hello?
								</Label>
								<Input
									disabled={!form.proactiveOpening}
									id="channel-proactive-target"
									onChange={(e) =>
										setForm((f) => ({ ...f, proactiveTarget: e.target.value }))
									}
									placeholder="The approved chat or phone number"
									value={form.proactiveTarget}
								/>
								<p className="text-muted-foreground text-xs">
									Enter one approved chat. Ryu never sends a welcome to
									everyone.
								</p>
							</div>
						</div>

						<div className="flex items-center justify-between rounded-lg border bg-card p-4">
							<div>
								<p className="font-medium text-sm">Enabled</p>
								<p className="text-muted-foreground text-xs">
									The gateway registers enabled bots when it starts.
								</p>
							</div>
							<Switch
								aria-label="Enable channel"
								checked={form.enabled}
								onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
							/>
						</div>

						{formError ? (
							<p className="text-sm text-status-destructive">{formError}</p>
						) : null}
					</div>
				</ScrollFadeEffect>

				<DialogFooter>
					<Button onClick={() => handleDialogOpenChange(false)} variant="ghost">
						Cancel
					</Button>
					{/* The managed path submits itself the moment Telegram hands over a
					    token, so a manual "Create bot" here could only ever fail the
					    bot_token guard. The panel owns the action in that mode. */}
					{usingManaged ? null : (
						<Button
							loading={saving}
							onClick={() => {
								handleSave().catch(() => undefined);
							}}
						>
							Create bot
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
