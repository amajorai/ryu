"use client";

// Presentational layer of the desktop Channels page. The live app
// (`apps/desktop/src/pages/ChannelsPage.tsx`) is a thin container that loads
// channel configs and agents via hooks and renders this view with real
// handlers; the storyboard renders the same component with mock data and no-op
// handlers. One source of truth, so editing this block changes the real desktop.
//
// Local UI state (which channel is selected, the edit form fields) stays inside
// this component — it is plain UI state, renders fine server-side, and is not
// app/backend/Tauri state. Everything that needs the backend (the channel list,
// agents, auth status, save/delete) is passed in as props.

import {
	Add01Icon,
	BubbleChatIcon,
	Delete01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription, AlertTitle } from "@ryu/ui/components/alert";
import { Badge } from "@ryu/ui/components/badge";
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
import { Textarea } from "@ryu/ui/components/textarea";
import { useCallback, useEffect, useState } from "react";

// ── Channel type model (mirrors apps/desktop/src/lib/api/channels.ts) ─────────

export const CHANNEL_TYPES = [
	"telegram",
	"slack",
	"whatsapp",
	"discord",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

// When the bot replies inside a group/multi-user chat (DMs always reply).
// Mirrors GROUP_REPLY_MODES in packages/db/src/models/channel.model.ts.
export const GROUP_REPLY_MODES = ["mentions", "all"] as const;
export type GroupReplyMode = (typeof GROUP_REPLY_MODES)[number];
const DEFAULT_GROUP_REPLY_MODE: GroupReplyMode = "mentions";

const GROUP_REPLY_LABELS: Record<GroupReplyMode, string> = {
	mentions: "Only when mentioned",
	all: "Every message",
};

// Every platform below has a real, registered gateway adapter
// (apps/gateway/src/channels/{telegram,slack,whatsapp,discord}.rs), so none are
// gated. What differs is the setup each one demands — see CHANNEL_SETUP.
//
// The required keys MUST match what the adapter actually bails on at construction
// time, or a bot saves fine and then dies at gateway startup with a bare "failed
// to register channel". Sources of truth:
//   telegram → telegram.rs (bot_token)
//   slack    → slack.rs:78-83   (app_token, bot_token)
//   whatsapp → whatsapp.rs:88-102 (access_token, phone_number_id, verify_token,
//              app_secret — app_secret is mandatory: it verifies the inbound
//              X-Hub-Signature-256 on every Meta webhook POST)
//   discord  → discord.rs:88-92 (bot_token, channel_ids — the adapter bails on an
//              empty channel_ids, and it is stored as one comma-separated secret
//              which discord_cfg_from_store splits on ',')
export const REQUIRED_SECRETS: Record<ChannelType, string[]> = {
	telegram: ["bot_token"],
	slack: ["app_token", "bot_token"],
	whatsapp: ["access_token", "phone_number_id", "verify_token", "app_secret"],
	discord: ["bot_token", "channel_ids"],
};

export const SECRET_LABELS: Record<string, string> = {
	bot_token: "Bot token",
	app_token: "App token",
	access_token: "Access token",
	phone_number_id: "Phone number ID",
	verify_token: "Verify token",
	app_secret: "App secret",
	channel_ids: "Channel IDs (comma-separated)",
};

export const CHANNEL_LABELS: Record<ChannelType, string> = {
	telegram: "Telegram",
	slack: "Slack",
	whatsapp: "WhatsApp",
	discord: "Discord",
};

/** Per-platform setup guidance shown in the credentials card. */
interface ChannelSetup {
	/** One line under the Credentials heading: what this platform needs overall. */
	note: string;
	/** Helper text per secret key. Keyed per platform because the same key name
	 * (`bot_token`) means a different thing on Telegram vs Slack vs Discord. */
	secretHelp: Record<string, string>;
	/** Hard prerequisite the user must satisfy OUTSIDE Ryu before the bot can
	 * receive anything (today: only WhatsApp, which needs a public HTTPS webhook). */
	warning?: string;
}

/** The gateway's WhatsApp receiver binds this fixed address/path for every
 * store-configured bot (apps/gateway/src/channels/mod.rs:400-401). Stated in the
 * UI verbatim because the user must proxy exactly this to a public HTTPS URL. */
const WHATSAPP_WEBHOOK_BIND = "0.0.0.0:8443";
const WHATSAPP_WEBHOOK_PATH = "/webhooks/whatsapp";

export const CHANNEL_SETUP: Record<ChannelType, ChannelSetup> = {
	telegram: {
		note: "Create a bot with @BotFather and paste its token. No public URL needed — the gateway long-polls Telegram.",
		secretHelp: {
			bot_token: "From @BotFather (/newbot), e.g. 123456:ABC-DEF…",
		},
	},
	slack: {
		note: "Slack runs over Socket Mode, so no public URL is needed — the gateway opens an outbound WebSocket. Three things must all be true or the bot connects and never hears anything: (1) Socket Mode is ON; (2) Event Subscriptions → Subscribe to bot events includes message.channels (public channels), message.groups (private), message.im (DMs), message.mpim (group DMs) — add only the ones you need, each paired with its history scope below; (3) after adding scopes you REINSTALL the app to the workspace and /invite the bot into every channel it should listen in — Slack never delivers channel messages to a bot that is not a member. For DMs, also enable App Home → Messages tab → “Allow users to send Slash commands and messages from the messages tab”.",
		secretHelp: {
			app_token:
				"App-level token (starts with xapp-) with the connections:write scope, from Slack app → Basic Information → App-Level Tokens. Socket Mode must also be toggled ON (Settings → Socket Mode) or apps.connections.open is refused.",
			bot_token:
				"Bot user OAuth token (starts with xoxb-) from Slack app → OAuth & Permissions. Scopes: chat:write to SEND, plus a history scope for every place it must LISTEN — channels:history (public channels), groups:history (private channels), im:history (DMs), mpim:history (group DMs). chat:write alone makes a bot that can talk but can never hear. Reinstall the app after changing scopes.",
		},
	},
	whatsapp: {
		note: "WhatsApp uses the Meta Cloud API, which delivers messages by webhook — this is the only platform that needs a publicly reachable HTTPS URL.",
		secretHelp: {
			access_token:
				"Meta Cloud API access token. Meta app → WhatsApp → API Setup. Temporary tokens expire in 24h; use a permanent System User token in production.",
			phone_number_id:
				"The Phone number ID (a numeric id, NOT the phone number itself) shown in Meta app → WhatsApp → API Setup.",
			verify_token:
				"A random string you invent. You paste the same value into Meta's webhook callback config; it's only used for the subscription handshake.",
			app_secret:
				"Meta app → Settings → Basic → App Secret. Used to verify the X-Hub-Signature-256 on every inbound webhook — without it, the payload is spoofable, so it is required.",
		},
		warning: `The gateway serves the WhatsApp webhook on ${WHATSAPP_WEBHOOK_BIND}${WHATSAPP_WEBHOOK_PATH}, but Meta only delivers to a public HTTPS URL. Put an HTTPS reverse proxy in front of that port, then register https://<your-domain>${WHATSAPP_WEBHOOK_PATH} — with the same Verify token as above — as the callback URL in Meta app → WhatsApp → Configuration. Until you do, the bot can send but will never receive. The port is fixed today, so only one WhatsApp bot can run per gateway.`,
	},
	discord: {
		note: "Discord runs over the gateway WebSocket — no public URL needed. Enable the Message Content privileged intent in the Discord Developer Portal.",
		secretHelp: {
			bot_token:
				"Discord Developer Portal → your application → Bot → Reset/Copy Token.",
			channel_ids:
				"The channels the bot listens in, comma-separated. Enable Developer Mode in Discord, then right-click a channel → Copy Channel ID. At least one is required — the adapter refuses to start without it.",
		},
	},
};

/** A channel config as the view needs it. */
export interface ChannelConfigView {
	agentId: string | null;
	channelType: ChannelType;
	enabled: boolean;
	/** When the bot replies in a group chat (mentions-only vs every message). */
	groupReplyMode: GroupReplyMode;
	id: string;
	model: string | null;
	name: string;
	/** Credential keys already stored server-side (shown as "set"). */
	secrets: Record<string, string>;
	systemPrompt: string | null;
	/** Team this bot routes to instead of a single agent (lead orchestrates
	 * the members). Mutually exclusive with agentId. */
	teamId: string | null;
}

/** Payload the container persists on save (create or update). */
export interface ChannelSavePayload {
	agentId: string | null;
	channelType: ChannelType;
	enabled: boolean;
	groupReplyMode: GroupReplyMode;
	model: string | null;
	name: string;
	secrets: Record<string, string>;
	systemPrompt: string | null;
	teamId: string | null;
}

export interface AgentOption {
	id: string;
	name: string;
}

export interface ChannelsViewProps {
	agents: AgentOption[];
	authed?: boolean;
	channels: ChannelConfigView[];
	error?: string | null;
	/** Seed the "new channel" form open. */
	initialNew?: boolean;
	/** Seed selection for storyboard determinism (e.g. the "edit" variant). */
	initialSelectedId?: string | null;
	loading?: boolean;
	onDelete?: (id: string) => void;
	/** Returns true on success so the view can leave the new-channel mode. */
	onSave?: (
		payload: ChannelSavePayload,
		ctx: { isNew: boolean; id: string | null }
	) => boolean | Promise<boolean>;
	onSignIn?: () => void;
	/**
	 * Adapter types contributed by enabled plugins (`RunnableKind::Channel`). Shown
	 * in the platform picker as DISABLED options — functional channels need the
	 * unbuilt plugin runtime, so they're informational only (selecting one would
	 * 400 on save since the persisted `ChannelType` enum is fixed).
	 */
	pluginPlatforms?: { id: string; name: string; platform: string }[];
	saving?: boolean;
	/** Teams the bot can route to (a lead agent orchestrating its members). */
	teams?: AgentOption[];
}

interface FormState {
	agentId: string;
	channelType: ChannelType;
	enabled: boolean;
	existingSecretKeys: string[];
	groupReplyMode: GroupReplyMode;
	model: string;
	name: string;
	secrets: Record<string, string>;
	systemPrompt: string;
}

const DEFAULT_AGENT = "__default__";
// Sentinel prefix on the unified target <select> value so a team selection is
// distinguishable from an agent id (the two come from different id namespaces).
const TEAM_PREFIX = "team:";

function emptyForm(): FormState {
	return {
		channelType: "telegram",
		name: "",
		agentId: DEFAULT_AGENT,
		model: "",
		systemPrompt: "",
		groupReplyMode: DEFAULT_GROUP_REPLY_MODE,
		enabled: false,
		secrets: {},
		existingSecretKeys: [],
	};
}

function formFromConfig(c: ChannelConfigView): FormState {
	// `agentId` holds the unified target value: a team takes the `team:<id>`
	// form, otherwise the agent id (or the default-agent sentinel).
	let target = DEFAULT_AGENT;
	if (c.teamId) {
		target = `${TEAM_PREFIX}${c.teamId}`;
	} else if (c.agentId) {
		target = c.agentId;
	}
	return {
		channelType: c.channelType,
		name: c.name,
		agentId: target,
		model: c.model ?? "",
		systemPrompt: c.systemPrompt ?? "",
		groupReplyMode: c.groupReplyMode ?? DEFAULT_GROUP_REPLY_MODE,
		enabled: c.enabled,
		secrets: {},
		existingSecretKeys: Object.keys(c.secrets ?? {}),
	};
}

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
	onSignIn,
	onSave,
	onDelete,
	pluginPlatforms = [],
}: ChannelsViewProps) {
	const [selectedId, setSelectedId] = useState<string | null>(
		initialSelectedId
	);
	const [isNew, setIsNew] = useState(initialNew);
	const [form, setForm] = useState<FormState>(emptyForm);
	const [formError, setFormError] = useState<string | null>(null);

	const selected = channels.find((c) => c.id === selectedId) ?? null;

	useEffect(() => {
		if (isNew) {
			setForm(emptyForm());
		} else if (selected) {
			setForm(formFromConfig(selected));
		}
		setFormError(null);
	}, [selected, isNew]);

	const openNew = useCallback(() => {
		setSelectedId(null);
		setIsNew(true);
	}, []);

	const handleSelect = useCallback((c: ChannelConfigView) => {
		setSelectedId(c.id);
		setIsNew(false);
	}, []);

	const requiredKeys = REQUIRED_SECRETS[form.channelType];
	const setup = CHANNEL_SETUP[form.channelType];

	const handleSave = useCallback(async () => {
		setFormError(null);
		if (!form.name.trim()) {
			setFormError("Name is required.");
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
					`Missing required: ${missing
						.map((k) => SECRET_LABELS[k] ?? k)
						.join(", ")}`
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
				model: form.model.trim() || null,
				systemPrompt: form.systemPrompt.trim() || null,
				enabled: form.enabled,
			},
			{ isNew, id: selected?.id ?? null }
		);
		if (ok) {
			setIsNew(false);
		}
	}, [form, isNew, selected, requiredKeys, onSave]);

	const handleDelete = useCallback(
		(c: ChannelConfigView) => {
			onDelete?.(c.id);
			if (selectedId === c.id) {
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
						<HugeiconsIcon icon={BubbleChatIcon} />
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

	const showForm = isNew || selected !== null;

	return (
		<div className="flex h-full overflow-hidden">
			{/* List */}
			<div className="flex w-60 shrink-0 flex-col border-r">
				<div className="flex items-center justify-between border-b px-3 py-2">
					<span className="font-semibold text-sm">Channels</span>
					<Button
						aria-label="New channel"
						onClick={openNew}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
					</Button>
				</div>

				{loading ? (
					<div className="flex flex-1 items-center justify-center">
						<Spinner />
					</div>
				) : channels.length === 0 ? (
					<div className="p-4 text-muted-foreground text-xs">
						{error ?? "No bots yet. Create one to connect a chat platform."}
					</div>
				) : (
					<ul className="flex flex-1 flex-col overflow-y-auto p-1">
						{channels.map((c) => (
							<li key={c.id}>
								<button
									className={`group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent ${
										selectedId === c.id && !isNew ? "bg-accent" : ""
									}`}
									onClick={() => handleSelect(c)}
									type="button"
								>
									<span className="min-w-0 flex-1 truncate text-xs">
										{c.name}
									</span>
									<Badge className="shrink-0 text-[9px]" variant="secondary">
										{CHANNEL_LABELS[c.channelType]}
									</Badge>
									<span
										aria-label={c.enabled ? "Enabled" : "Disabled"}
										className={`size-1.5 shrink-0 rounded-full ${
											c.enabled ? "bg-green-500" : "bg-muted-foreground/40"
										}`}
									/>
									<button
										aria-label={`Delete ${c.name}`}
										className="shrink-0 opacity-0 group-hover:opacity-100"
										onClick={(e) => {
											e.stopPropagation();
											handleDelete(c);
										}}
										type="button"
									>
										<HugeiconsIcon
											className="size-3 text-destructive"
											icon={Delete01Icon}
										/>
									</button>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* Form */}
			{showForm ? (
				<div className="flex-1 overflow-y-auto">
					<div className="mx-auto max-w-xl space-y-5 p-6">
						<h1 className="font-semibold text-lg">
							{isNew ? "New channel bot" : selected?.name}
						</h1>

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
								disabled={!isNew}
								id="channel-type"
								onChange={(e) =>
									setForm((f) => ({
										...f,
										channelType: e.target.value as ChannelType,
										secrets: {},
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
											<NativeSelectOption
												disabled
												key={p.id}
												value={p.platform}
											>
												{p.name} (Requires plugin runtime)
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

						{/* Credentials — the fields are exactly what the platform's
						    gateway adapter refuses to start without. */}
						<div className="space-y-3 rounded-lg border bg-card p-4">
							<p className="font-medium text-sm">Credentials</p>
							<p className="text-muted-foreground text-xs">{setup.note}</p>
							{requiredKeys.map((key) => {
								const isSet = form.existingSecretKeys.includes(key);
								const help = setup.secretHelp[key];
								return (
									<div className="space-y-1.5" key={key}>
										<Label htmlFor={`secret-${key}`}>
											{SECRET_LABELS[key] ?? key}
										</Label>
										<Input
											aria-describedby={help ? `secret-${key}-help` : undefined}
											autoComplete="off"
											id={`secret-${key}`}
											onChange={(e) =>
												setForm((f) => ({
													...f,
													secrets: { ...f.secrets, [key]: e.target.value },
												}))
											}
											placeholder={
												isSet ? "•••••••• (unchanged)" : "Paste value"
											}
											type="password"
											value={form.secrets[key] ?? ""}
										/>
										{help ? (
											<p
												className="text-muted-foreground text-xs"
												id={`secret-${key}-help`}
											>
												{help}
											</p>
										) : null}
									</div>
								);
							})}
							<p className="text-muted-foreground text-xs">
								Values are stored encrypted and never shown again. On edit,
								leave a field blank to keep the stored value.
							</p>
						</div>

						{/* Hard external prerequisite (today: WhatsApp's public webhook). */}
						{setup.warning ? (
							<Alert>
								<AlertTitle>Needs a public HTTPS webhook</AlertTitle>
								<AlertDescription>{setup.warning}</AlertDescription>
							</Alert>
						) : null}

						{/* Routing: a single agent, or a team whose lead agent
						    orchestrates and calls the other members. */}
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
									<optgroup label="Teams">
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
								Pick a single agent, or a team — the team's lead agent
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
										groupReplyMode: e.target.value as GroupReplyMode,
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
								whether it replies only when @mentioned (or replied to) or to
								every message. Direct messages always get a reply.
							</p>
						</div>

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
							<p className="text-destructive text-sm">{formError}</p>
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
								<Button onClick={() => handleDelete(selected)} variant="ghost">
									Delete
								</Button>
							) : null}
						</div>
					</div>
				</div>
			) : (
				<Empty className="flex-1">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={BubbleChatIcon} />
						</EmptyMedia>
						<EmptyTitle>Connect a chat platform</EmptyTitle>
						<EmptyDescription>
							Add a Telegram, Slack, WhatsApp, or Discord bot and route it to
							one of your agents or a team.
						</EmptyDescription>
					</EmptyHeader>
					<Button className="mt-2" onClick={openNew} size="sm">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						New channel
					</Button>
				</Empty>
			)}
		</div>
	);
}
