"use client";

// Presentational layer of the desktop Channels page. The live app
// (`apps/desktop/src/pages/ChannelsPage.tsx`) is a thin container that loads
// channel configs and agents via hooks and renders this view with real
// handlers; the storyboard renders the same component with mock data and no-op
// handlers. One source of truth, so editing this block changes the real desktop.
//
// The Channels sidebar section (AppSidebar) is the bot picker now, so this view
// is a single full-width detail: create/edit form for the seeded channel, or an
// empty prompt to pick one from the sidebar. Local UI state (form fields) stays
// inside this component — everything that needs the backend (channel configs,
// agents, auth status, save/delete) is passed in as props.

import { Add01Icon, Tv01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Alert, AlertDescription, AlertTitle } from "@ryu/ui/components/alert";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChannelBehaviourSection } from "./channels-behaviour-section.tsx";
import {
	CHANNEL_TYPES,
	channelTypeInputSchema,
	OPTIONAL_SECRETS,
	PLATFORM_OPTION_FIELDS,
	REQUIRED_SECRETS,
} from "./channels-constants.ts";
import { ChannelCredentialsSection } from "./channels-credentials-section.tsx";
import { ChannelManagedBotAlert } from "./channels-managed-bot-alert.tsx";
import {
	behaviorFromConfig,
	type ChannelConfigView,
	type ChannelsViewProps,
	DEFAULT_AGENT,
	emptyForm,
	type FormState,
	formFromConfig,
	managedDiscordInstallUrl,
	managedTelegramBotUrl,
	parsePlatformOptions,
	supportedSettings,
	TEAM_PREFIX,
} from "./channels-model.ts";
import { ChannelProfileSection } from "./channels-profile-section.tsx";
import {
	ChannelAccessSection,
	ChannelRoutingSection,
} from "./channels-routing-section.tsx";
import {
	CHANNEL_LABELS,
	CHANNEL_SETUP,
	SECRET_LABELS,
} from "./channels-setup.ts";

export {
	CHANNEL_TYPES,
	type ChannelType,
	DEFAULT_DM_POLICY,
	DEFAULT_GROUP_POLICY,
	DEFAULT_GROUP_REPLY_MODE,
	DEFAULT_VOICE_REPLY_MODE,
	DM_POLICIES,
	DM_POLICY_LABELS,
	type DmPolicy,
	defaultReactionLearningSettings,
	GROUP_POLICIES,
	GROUP_POLICY_LABELS,
	GROUP_REPLY_LABELS,
	GROUP_REPLY_MODES,
	type GroupPolicy,
	type GroupReplyMode,
	OPTIONAL_SECRETS,
	PLATFORM_OPTION_FIELDS,
	type PlatformOptionRegistry,
	REQUIRED_SECRETS,
	type ReactionLearningSettings,
	VOICE_REPLY_LABELS,
	VOICE_REPLY_MODES,
	type VoiceReplyMode,
} from "./channels-constants.ts";
export {
	type AgentOption,
	type ChannelBehaviorSettings,
	type ChannelConfigView,
	type ChannelSavePayload,
	type ChannelsViewProps,
	defaultBehaviorSettings,
	managedDiscordInstallUrl,
	managedTelegramBotUrl,
	supportedSettings,
} from "./channels-model.ts";
export {
	CHANNEL_LABELS,
	CHANNEL_SETUP,
	type ChannelSecretLabels,
	SECRET_LABELS,
} from "./channels-setup.ts";

export function ChannelsView({
	authed = true,
	loading,
	error,
	channels,
	agents,
	teams = [],
	saving,
	initialSelectedId = null,
	initialNew = false,
	initialChannelType = "telegram",
	canDelete = true,
	onSignIn,
	onSave,
	onDelete,
	pluginPlatforms = [],
}: ChannelsViewProps) {
	const [selectedId, setSelectedId] = useState<string | null>(
		initialSelectedId
	);
	const [isNew, setIsNew] = useState(initialNew);
	const [form, setForm] = useState<FormState>(() =>
		emptyForm(initialChannelType)
	);
	const [formError, setFormError] = useState<string | null>(null);
	const tl = useLiteralMessages();

	// Sidebar / deep-link navigation remounts are rare; still re-seed when the
	// manage route switches channel id or opens create.
	useEffect(() => {
		setSelectedId(initialSelectedId);
		setIsNew(initialNew);
	}, [initialSelectedId, initialNew]);

	const selected = channels.find((c) => c.id === selectedId) ?? null;
	// Hosts often rebuild `channels` inline on every render, so the selected
	// object's identity is not a reliable "the channel changed" signal. Seed the
	// form only when the edited channel id (or create mode) changes, or after a
	// successful save bumps `reseedToken`; read the latest copy through a ref.
	const selectedKey = selected?.id ?? null;
	const selectedRef = useRef(selected);
	const [reseedToken, setReseedToken] = useState(0);

	useEffect(() => {
		selectedRef.current = selected;
	});

	useEffect(() => {
		const current = selectedRef.current;
		if (isNew) {
			setForm(emptyForm(initialChannelType));
		} else if (current) {
			setForm(formFromConfig(current));
		}
		setFormError(null);
	}, [selectedKey, isNew, initialChannelType, reseedToken]);

	const openNew = useCallback(() => {
		setSelectedId(null);
		setIsNew(true);
	}, []);

	const requiredKeys = REQUIRED_SECRETS[form.channelType];
	const optionalKeys = OPTIONAL_SECRETS[form.channelType];
	const platformOptionFields = PLATFORM_OPTION_FIELDS[form.channelType] ?? [];
	// Only render a toggle the selected platform can actually honour — a control
	// that does nothing reads as a promise the bot won't keep.
	const supported = supportedSettings(form.channelType);
	const setup = CHANNEL_SETUP[form.channelType];
	const managedBotReady =
		selected?.credentialSource === "ryu_managed" &&
		selected.managedProvisioningState === "ready";
	const managedBotActionUrl = managedBotReady
		? selected.channelType === "telegram"
			? managedTelegramBotUrl(selected.managedBotUsername)
			: selected.channelType === "discord"
				? managedDiscordInstallUrl(selected.managedBotId)
				: null
		: null;

	const handleSave = useCallback(async () => {
		setFormError(null);
		if (!form.name.trim()) {
			setFormError("Name is required.");
			return;
		}
		if (form.proactiveOpening && !form.proactiveTarget?.trim()) {
			setFormError(
				"Choose the approved chat that should receive Ryu's welcome."
			);
			return;
		}

		// Decode the unified target value into a mutually-exclusive agent/team.
		let agentId: string | null = null;
		let teamId: string | null = null;
		if (form.agentId.startsWith(TEAM_PREFIX)) {
			teamId = form.agentId.slice(TEAM_PREFIX.length);
		} else if (form.agentId !== DEFAULT_AGENT) {
			agentId = form.agentId;
		}
		const secrets: Record<string, string> = {};
		for (const [key, value] of Object.entries(form.secrets)) {
			if (value.trim()) {
				secrets[key] = value.trim();
			}
		}

		if (isNew) {
			const missing = requiredKeys.filter((k) => !secrets[k]);
			if (missing.length > 0) {
				setFormError(
					tl("Missing required: {missing}", {
						missing: missing.map((k) => SECRET_LABELS[k] ?? k).join(", "),
					})
				);
				return;
			}
		}

		const ok = await onSave?.(
			{
				channelType: form.channelType,
				name: form.name.trim(),
				secrets,
				agentId,
				teamId,
				groupReplyMode: form.groupReplyMode,
				platformOptions: parsePlatformOptions(
					form.channelType,
					form.platformOptionInputs
				),
				model: form.model.trim() || null,
				systemPrompt: form.systemPrompt.trim() || null,
				enabled: form.enabled,
				...behaviorFromConfig(form),
			},
			{ isNew, id: selected?.id ?? null }
		);
		if (ok) {
			setIsNew(false);
			setReseedToken((token) => token + 1);
		} else if (ok === false) {
			setFormError("Couldn't save this channel. Please try again.");
		}
	}, [form, isNew, selected, requiredKeys, onSave, tl]);

	const handleDelete = useCallback(
		async (c: ChannelConfigView) => {
			const removed = await onDelete?.(c.id);
			if (removed !== false && selectedId === c.id) {
				setSelectedId(null);
				setIsNew(false);
			}
		},
		[onDelete, selectedId]
	);

	if (!authed) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Tv01Icon} />
					</EmptyMedia>
					<EmptyTitle>Sign in to manage channels</EmptyTitle>
					<EmptyDescription>
						Channel bots are stored in your account. Sign in to add a Telegram,
						Slack, WhatsApp, or Discord bot.
					</EmptyDescription>
				</EmptyHeader>
				<Button className="mt-2" onClick={onSignIn} size="sm">
					Sign in
				</Button>
			</Empty>
		);
	}

	if (loading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	const showForm = isNew || selected !== null;

	if (!showForm) {
		const emptyTitle =
			channels.length === 0 ? "No channel bots yet" : "Select a channel";
		const emptyDescription =
			channels.length === 0
				? (error ??
					"Add a Telegram, Slack, WhatsApp, or Discord bot from the sidebar and route it to an agent or team.")
				: "Pick a channel from the sidebar to edit it, or create a new one.";
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Tv01Icon} />
					</EmptyMedia>
					<EmptyTitle>{emptyTitle}</EmptyTitle>
					<EmptyDescription>{emptyDescription}</EmptyDescription>
				</EmptyHeader>
				<Button className="mt-2" onClick={openNew} size="sm">
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					New channel
				</Button>
			</Empty>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="scroll-fade flex-1 overflow-y-auto">
				<div className="mx-auto max-w-xl space-y-5 p-6">
					{error ? (
						<p className="text-sm text-status-destructive">{error}</p>
					) : null}
					{selected?.bindingWarning ? (
						<Alert>
							<AlertTitle>Agent binding needs attention</AlertTitle>
							<AlertDescription>{selected.bindingWarning}</AlertDescription>
						</Alert>
					) : null}
					{selected?.credentialSource === "ryu_managed" ? (
						<ChannelManagedBotAlert
							managedBotActionUrl={managedBotActionUrl}
							selected={selected}
						/>
					) : null}
					<h1 className="font-medium text-lg">
						{isNew ? "New channel bot" : selected?.name}
					</h1>

					<div className="space-y-1.5">
						<Label htmlFor="channel-name">Name</Label>
						<Input
							id="channel-name"
							onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
							placeholder="e.g. Support bot"
							value={form.name}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="channel-type">Platform</Label>
						<NativeSelect
							disabled={!isNew}
							id="channel-type"
							onChange={(e) =>
								setForm((f) => ({
									...f,
									channelType: channelTypeInputSchema.parse(e.target.value),
									secrets: {},
									platformOptionInputs: {},
								}))
							}
							value={form.channelType}
						>
							{CHANNEL_TYPES.map((t) => (
								<NativeSelectOption key={t} value={t}>
									{CHANNEL_LABELS[t]}
								</NativeSelectOption>
							))}
							{pluginPlatforms.length > 0 ? (
								<optgroup label="From plugins">
									{pluginPlatforms.map((p) => (
										<NativeSelectOption disabled key={p.id} value={p.platform}>
											{tl("{name} (Requires plugin runtime)", { name: p.name })}
										</NativeSelectOption>
									))}
								</optgroup>
							) : null}
						</NativeSelect>
						{isNew ? null : (
							<p className="text-muted-foreground text-xs">
								Platform can't be changed after creation.
							</p>
						)}
					</div>

					<ChannelCredentialsSection
						form={form}
						managedBotReady={managedBotReady}
						optionalKeys={optionalKeys}
						platformOptionFields={platformOptionFields}
						requiredKeys={requiredKeys}
						setForm={setForm}
						setup={setup}
					/>

					<ChannelRoutingSection
						agents={agents}
						form={form}
						setForm={setForm}
						teams={teams}
					/>

					<ChannelAccessSection form={form} setForm={setForm} />

					<ChannelBehaviourSection
						form={form}
						setForm={setForm}
						supported={supported}
					/>

					{supported.profile ? (
						<ChannelProfileSection form={form} setForm={setForm} />
					) : null}

					<div className="flex items-center justify-between rounded-lg border bg-card p-4">
						<div>
							<p className="font-medium text-sm">Enabled</p>
							<p className="text-muted-foreground text-xs">
								The gateway registers enabled bots when it starts, so a new or
								edited bot only goes live after the gateway restarts. Note: in
								multi-tenant setups the gateway only picks up org-scoped
								configs, so a bot created here may not auto-start yet.
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

					<div className="flex items-center gap-2">
						<Button
							disabled={saving}
							onClick={() => {
								handleSave().catch(() => undefined);
							}}
						>
							{saving ? "Saving…" : isNew ? "Create bot" : "Save changes"}
						</Button>
						{!isNew && selected ? (
							<Button
								disabled={!canDelete}
								onClick={() => handleDelete(selected)}
								title={
									canDelete
										? undefined
										: "Requires the channel.delete permission"
								}
								variant="ghost"
							>
								Delete
							</Button>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
