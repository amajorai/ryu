import type { AgentOption } from "@ryu/blocks/desktop/channels.tsx";
import {
	CHANNEL_LABELS,
	CHANNEL_SETUP,
	CHANNEL_TYPES,
	type ChannelType,
	type GroupReplyMode,
	REQUIRED_SECRETS,
	type ReactionLearningSettings,
	SECRET_LABELS,
} from "@ryu/blocks/desktop/channels.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import { TelegramManagedBotPanel } from "@/src/components/channels/TelegramManagedBotPanel.tsx";
import { ScrollFadeEffect } from "@/src/components/ui/scroll-fade-effect.tsx";
import {
	type ConnectMode,
	emptyForm,
	type FormState,
	splitBinding,
} from "./AddChannelDialog-form.ts";
import {
	AddChannelReactionLearningSection,
	AddChannelStartupSection,
} from "./AddChannelDialog-options-sections.tsx";
import { AddChannelRoutingSection } from "./AddChannelDialog-routing-section.tsx";
import { ManualSecretFields } from "./AddChannelDialog-secret-fields.tsx";

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
	const tl = useLiteralMessages();
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
					tl("Missing required: {fields}", {
						fields: missing.map((k) => SECRET_LABELS[k] ?? k).join(", "),
					})
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
		[form, requiredKeys, onCreate, onOpenChange, tl]
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

						<div className="flex flex-col gap-3 border-border border-t pt-4">
							<p className="font-semibold text-sm">Credentials</p>
							{managedAvailable ? (
								<div className="flex gap-2">
									<Button
										onClick={() => setConnectMode("managed")}
										size="sm"
										variant={usingManaged ? "secondary" : "ghost"}
									>
										Create a bot for me
									</Button>
									<Button
										onClick={() => setConnectMode("manual")}
										size="sm"
										variant={usingManaged ? "ghost" : "secondary"}
									>
										Paste a token
									</Button>
								</div>
							) : null}
							{managedNotice ? (
								<p className="text-detail text-muted-foreground">
									{tl(
										"{managedNotice} Create one with @BotFather and paste its token below instead.",
										{ managedNotice }
									)}
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
								<p className="text-detail text-muted-foreground">
									{setup.note}
								</p>
							)}
							<ManualSecretFields
								keys={usingManaged ? [] : requiredKeys}
								onChange={(key, value) =>
									setForm((f) => ({
										...f,
										secrets: { ...f.secrets, [key]: value },
									}))
								}
								secretHelp={setup.secretHelp}
								secrets={form.secrets}
							/>
							<p className="text-detail text-muted-foreground">
								Values are stored encrypted and never shown again.
							</p>
						</div>
						{setup.warning ? (
							<Alert>
								<AlertDescription>{setup.warning}</AlertDescription>
							</Alert>
						) : null}

						<AddChannelRoutingSection
							agents={agents}
							form={form}
							setForm={setForm}
							teams={teams}
						/>

						{form.channelType === "telegram" ? (
							<AddChannelReactionLearningSection
								form={form}
								setForm={setForm}
							/>
						) : null}

						<AddChannelStartupSection form={form} setForm={setForm} />

						{formError ? <ErrorLine message={formError} /> : null}
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
