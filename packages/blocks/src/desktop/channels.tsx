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
import { Alert, AlertDescription, AlertTitle } from "@ryu/ui/components/alert";
import { Button, buttonVariants } from "@ryu/ui/components/button";
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
	"whatsapp_personal",
	"discord",
	"bluebubbles",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

// When the bot replies inside a group/multi-user chat (DMs always reply).
// Mirrors GROUP_REPLY_MODES in packages/db/src/models/channel.model.ts.
export const GROUP_REPLY_MODES = ["mentions", "all"] as const;
export type GroupReplyMode = (typeof GROUP_REPLY_MODES)[number];
export const DEFAULT_GROUP_REPLY_MODE: GroupReplyMode = "mentions";

export const GROUP_REPLY_LABELS: Record<GroupReplyMode, string> = {
	mentions: "Only when mentioned",
	all: "Every message",
};

// Who may DM the bot, and how a stranger enrols. Mirrors DM_POLICIES in
// packages/db/src/models/channel.model.ts and the gateway's pairing gate
// (crates/gateway/channels/src/pairing.rs).
export const DM_POLICIES = [
	"pairing",
	"allowlist",
	"open",
	"disabled",
] as const;
export type DmPolicy = (typeof DM_POLICIES)[number];
export const DEFAULT_DM_POLICY: DmPolicy = "pairing";

export const DM_POLICY_LABELS: Record<DmPolicy, string> = {
	pairing: "Ask me to approve new people",
	allowlist: "Only people on my list",
	open: "Anyone (billed to you)",
	disabled: "Nobody — groups only",
};

export const GROUP_POLICIES = ["allowlist", "open", "disabled"] as const;
export type GroupPolicy = (typeof GROUP_POLICIES)[number];
export const DEFAULT_GROUP_POLICY: GroupPolicy = "allowlist";

export const GROUP_POLICY_LABELS: Record<GroupPolicy, string> = {
	allowlist: "Only groups on my list",
	open: "Any group it's added to",
	disabled: "Never reply in groups",
};

// When the bot answers with synthesized speech as well as text.
export const VOICE_REPLY_MODES = ["never", "mirror", "always"] as const;
export type VoiceReplyMode = (typeof VOICE_REPLY_MODES)[number];
export const DEFAULT_VOICE_REPLY_MODE: VoiceReplyMode = "never";

export const VOICE_REPLY_LABELS: Record<VoiceReplyMode, string> = {
	never: "Text only",
	mirror: "Speak back to voice messages",
	always: "Speak every reply",
};

export interface ReactionLearningSettings {
	allowGroup: boolean;
	enabled: boolean;
	negativeEmoji: string[];
	positiveEmoji: string[];
}

export function defaultReactionLearningSettings(): ReactionLearningSettings {
	return {
		enabled: false,
		positiveEmoji: ["👍"],
		negativeEmoji: ["👎"],
		allowGroup: false,
	};
}

// Every platform below has a real, registered gateway adapter, so none are
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
//   whatsapp_personal → openwa.rs (openwa_url, openwa_api_key,
//              openwa_session_id, webhook_url, webhook_secret)
//   discord  → discord.rs (bot_token; channel ids are optional so DMs work)
export const REQUIRED_SECRETS: Record<ChannelType, string[]> = {
	telegram: ["bot_token"],
	slack: ["app_token", "bot_token"],
	whatsapp: ["access_token", "phone_number_id", "verify_token", "app_secret"],
	whatsapp_personal: [
		"openwa_url",
		"openwa_api_key",
		"openwa_session_id",
		"webhook_url",
		"webhook_secret",
	],
	discord: ["bot_token"],
	//   bluebubbles → bluebubbles.rs (server_url, password — the adapter bails on
	//              either being blank, since both are needed for every call)
	bluebubbles: ["server_url", "password"],
};

/** Optional per-channel transport settings. These are kept in the same
 * encrypted map so two WhatsApp records can listen on different local routes
 * without turning node-local webhook plumbing into a global setting. */
export const OPTIONAL_SECRETS: Record<ChannelType, string[]> = {
	telegram: ["webhook_secret"],
	slack: [],
	whatsapp: ["webhook_bind", "webhook_path", "graph_version"],
	whatsapp_personal: ["webhook_bind", "webhook_path", "self_chat_only"],
	discord: ["channel_ids"],
	bluebubbles: [],
};

type PlatformOptionKind = "boolean" | "list" | "number" | "text" | "url";

interface PlatformOptionField {
	help: string;
	key: string;
	kind: PlatformOptionKind;
	label: string;
}

/** Non-secret transport and mention controls stored in platformOptions. */
export const PLATFORM_OPTION_FIELDS: Partial<
	Record<ChannelType, PlatformOptionField[]>
> = {
	telegram: [
		{
			key: "webhook_url",
			label: "Public webhook URL",
			help: "Optional. Set this to use Telegram webhooks instead of long polling.",
			kind: "url",
		},
		{
			key: "webhook_bind",
			label: "Webhook bind",
			help: "Optional local listener address; defaults to the Gateway's Telegram listener.",
			kind: "text",
		},
		{
			key: "webhook_path",
			label: "Webhook path",
			help: "Optional route for Telegram webhook delivery.",
			kind: "text",
		},
		{
			key: "base_url",
			label: "Bot API base URL",
			help: "Optional custom Bot API endpoint for a local server or proxy.",
			kind: "url",
		},
		{
			key: "base_file_url",
			label: "Bot API file URL",
			help: "Optional custom file endpoint paired with the Bot API base URL.",
			kind: "url",
		},
		{
			key: "local_mode",
			label: "Local media mode",
			help: "Read Telegram file paths from the Gateway filesystem.",
			kind: "boolean",
		},
		{
			key: "mention_patterns",
			label: "Additional mention patterns",
			help: "Comma-separated case-insensitive phrases that address the bot in groups.",
			kind: "list",
		},
		{
			key: "ignored_threads",
			label: "Ignored topic IDs",
			help: "Comma-separated Telegram topic tags that the bot must ignore.",
			kind: "list",
		},
		{
			key: "exclusive_bot_mentions",
			label: "Require the bot mention",
			help: "Ignore generic patterns unless the bot itself is mentioned or invoked.",
			kind: "boolean",
		},
		{
			key: "guest_mode",
			label: "Guest queries",
			help: "Accept Telegram guest-query updates. Enabled by default.",
			kind: "boolean",
		},
		{
			key: "command_menu_max",
			label: "Maximum menu commands",
			help: "Telegram command-menu limit; clamped to 1–100.",
			kind: "number",
		},
	],
	slack: [
		{
			key: "reply_in_thread",
			label: "Reply in threads",
			help: "Keep channel replies in the triggering Slack thread.",
			kind: "boolean",
		},
		{
			key: "reply_broadcast",
			label: "Broadcast thread replies",
			help: "Also show a threaded reply in the parent channel.",
			kind: "boolean",
		},
		{
			key: "strict_mention",
			label: "Strict mentions",
			help: "Require a fresh mention for every channel message, including active threads.",
			kind: "boolean",
		},
		{
			key: "thread_require_mention",
			label: "Mention in active threads",
			help: "Require a mention even when a thread is already active.",
			kind: "boolean",
		},
		{
			key: "free_response_channels",
			label: "Free-response channels",
			help: "Comma-separated channel ids where the bot answers without a mention.",
			kind: "list",
		},
		{
			key: "require_mention_channels",
			label: "Mention-required channels",
			help: "Comma-separated channel ids that always require a mention.",
			kind: "list",
		},
		{
			key: "allowed_channels",
			label: "Allowed channels",
			help: "Comma-separated Slack channel ids to serve.",
			kind: "list",
		},
		{
			key: "ignored_channels",
			label: "Ignored channels",
			help: "Comma-separated Slack channel ids to ignore.",
			kind: "list",
		},
		{
			key: "allow_bots",
			label: "Accept bot messages",
			help: "Allow messages authored by other Slack bots.",
			kind: "boolean",
		},
		{
			key: "reply_prefix",
			label: "Reply prefix",
			help: "Optional text prepended to each Slack reply.",
			kind: "text",
		},
		{
			key: "mention_patterns",
			label: "Additional mention patterns",
			help: "Comma-separated case-insensitive phrases that address the bot.",
			kind: "list",
		},
		{
			key: "rich_blocks",
			label: "Rich blocks",
			help: "Render replies as native Slack Block Kit sections.",
			kind: "boolean",
		},
		{
			key: "feedback_buttons",
			label: "Feedback buttons",
			help: "Add Helpful and Needs work actions that confirm with a reaction.",
			kind: "boolean",
		},
	],
	discord: [
		{
			key: "history_backfill",
			label: "Backfill after reconnect",
			help: "Fetch messages missed while the Discord Gateway was disconnected.",
			kind: "boolean",
		},
		{
			key: "free_response_channels",
			label: "Free-response channels",
			help: "Comma-separated channel ids where the bot answers without a mention.",
			kind: "list",
		},
		{
			key: "allowed_channels",
			label: "Allowed channels",
			help: "Comma-separated Discord channel ids to serve.",
			kind: "list",
		},
		{
			key: "allowed_roles",
			label: "Allowed roles",
			help: "Comma-separated Discord role ids allowed to trigger the bot in guilds.",
			kind: "list",
		},
		{
			key: "thread_require_mention",
			label: "Mention in threads",
			help: "Require a mention even inside an active Discord thread.",
			kind: "boolean",
		},
		{
			key: "mention_patterns",
			label: "Additional mention patterns",
			help: "Comma-separated case-insensitive phrases that address the bot.",
			kind: "list",
		},
		{
			key: "ignored_channels",
			label: "Ignored channels",
			help: "Comma-separated Discord channel ids to ignore.",
			kind: "list",
		},
		{
			key: "no_thread_channels",
			label: "No-thread channels",
			help: "Comma-separated channel ids where replies stay in the channel.",
			kind: "list",
		},
		{
			key: "allow_bots",
			label: "Accept bot messages",
			help: "Allow messages authored by other Discord bots.",
			kind: "boolean",
		},
		{
			key: "home_channel",
			label: "Home channel",
			help: "Optional Discord channel for operator-triggered outbound sends.",
			kind: "text",
		},
	],
	bluebubbles: [
		{
			key: "webhook_bind",
			label: "Webhook bind",
			help: "Optional local bind for BlueBubbles webhook delivery.",
			kind: "text",
		},
		{
			key: "webhook_path",
			label: "Webhook path",
			help: "Optional path BlueBubbles posts to.",
			kind: "text",
		},
		{
			key: "private_api",
			label: "Private API helper",
			help: "Enable typing, read receipts, and tapbacks when installed on the Mac.",
			kind: "boolean",
		},
		{
			key: "mention_patterns",
			label: "Additional mention patterns",
			help: "Comma-separated phrases that address the bot in iMessage groups.",
			kind: "list",
		},
		{
			key: "home_channel",
			label: "Home chat",
			help: "Optional phone number, email, or BlueBubbles chat GUID for outbound sends.",
			kind: "text",
		},
	],
};

export const SECRET_LABELS: Record<string, string> = {
	bot_token: "Bot token",
	app_token: "App token",
	access_token: "Access token",
	phone_number_id: "Phone number ID",
	verify_token: "Verify token",
	app_secret: "App secret",
	openwa_url: "OpenWA base URL",
	openwa_api_key: "OpenWA API key",
	openwa_session_id: "OpenWA session ID",
	webhook_url: "Public webhook URL",
	webhook_secret: "Webhook secret",
	webhook_bind: "Local webhook bind",
	webhook_path: "Webhook path",
	graph_version: "Meta Graph API version",
	self_chat_only: "Self-chat mode (true/false)",
	channel_ids: "Legacy channel IDs (comma-separated, optional)",
	server_url: "BlueBubbles server URL",
	password: "BlueBubbles password",
};

export const CHANNEL_LABELS: Record<ChannelType, string> = {
	telegram: "Telegram",
	slack: "Slack",
	whatsapp: "WhatsApp Business (Cloud API)",
	whatsapp_personal: "WhatsApp Personal",
	discord: "Discord",
	bluebubbles: "iMessage (BlueBubbles)",
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
const WHATSAPP_PERSONAL_WEBHOOK_BIND = "0.0.0.0:8444";
const WHATSAPP_PERSONAL_WEBHOOK_PATH = "/webhooks/whatsapp-personal";

export const CHANNEL_SETUP: Record<ChannelType, ChannelSetup> = {
	telegram: {
		note: "Create a bot with @BotFather and paste its token. No public URL needed — the gateway long-polls Telegram.",
		secretHelp: {
			bot_token: "From @BotFather (/newbot), e.g. 123456:ABC-DEF…",
			webhook_secret:
				"Required when Public webhook URL is set. Telegram sends it as X-Telegram-Bot-Api-Secret-Token.",
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
			webhook_bind: `Local address for this channel's receiver. Defaults to ${WHATSAPP_WEBHOOK_BIND}; choose a distinct port per Cloud API channel.`,
			webhook_path: `Local path for this channel's receiver. Defaults to ${WHATSAPP_WEBHOOK_PATH}; register the same path in Meta's callback URL.`,
			graph_version:
				"Optional Graph API version override. Leave blank to use the gateway default.",
		},
		warning: `The gateway serves the WhatsApp webhook on ${WHATSAPP_WEBHOOK_BIND}${WHATSAPP_WEBHOOK_PATH} by default, but Meta only delivers to a public HTTPS URL. Put an HTTPS reverse proxy in front of that port, then register https://<your-domain>${WHATSAPP_WEBHOOK_PATH} — with the same Verify token as above — as the callback URL in Meta app → WhatsApp → Configuration. Use the optional bind/path fields below when this gateway hosts more than one Cloud API channel.`,
	},
	whatsapp_personal: {
		note: "WhatsApp Personal connects an OpenWA session you run yourself. Create and start the session in OpenWA, scan its QR code (or use its pairing code), then paste the session id and OpenWA operator key here. Ryu registers the webhook automatically.",
		secretHelp: {
			openwa_url:
				"The OpenWA base URL, e.g. http://127.0.0.1:2785. It must be reachable from the Ryu gateway.",
			openwa_api_key:
				"An OpenWA API key with OPERATOR access to this session. Send it only to Ryu; it is stored encrypted.",
			openwa_session_id:
				"The OpenWA session id/name you created. OpenWA uses it for QR linking, lifecycle, webhooks, and sends.",
			webhook_url:
				"The URL OpenWA can POST to, including the path, e.g. https://ryu.example.com/webhooks/whatsapp-personal.",
			webhook_secret:
				"A random shared secret. OpenWA signs every delivery with X-OpenWA-Signature and Ryu verifies it before parsing.",
			webhook_bind: `Local address for this channel's receiver. Defaults to ${WHATSAPP_PERSONAL_WEBHOOK_BIND}; choose a distinct port per personal channel.`,
			webhook_path: `Local path for this channel's receiver. Defaults to ${WHATSAPP_PERSONAL_WEBHOOK_PATH}; it must match the path in Public webhook URL.`,
			self_chat_only:
				"Optional true/false switch for Hermes-style self-chat mode. Leave blank for normal personal-account DMs and groups.",
		},
		warning:
			"This is an unofficial WhatsApp Web bridge, not Meta's Cloud API. Use a dedicated number: WhatsApp may restrict or ban linked personal accounts. OpenWA must be running and its session must be linked before messages can flow. The public webhook URL must reach the gateway; use a distinct bind/path for each channel record.",
	},
	discord: {
		note: "Discord runs over the gateway WebSocket — no public URL needed. Create each Discord application and bot in the Discord Developer Portal, enable the Message Content privileged intent, then paste its token here. Ryu can run multiple bot records, but Discord does not expose a public API for Ryu to create applications on your behalf.",
		secretHelp: {
			bot_token:
				"Discord Developer Portal → your application → Bot → Reset/Copy Token.",
			channel_ids:
				"Optional comma-separated guild channel ids. Leave blank to keep DMs working and use the advanced channel allowlist instead.",
		},
	},
	bluebubbles: {
		note: "iMessage is bridged by BlueBubbles Server running on a Mac you keep awake and signed into Messages.app. Ryu talks to it over HTTP on your network — there is no Apple API involved, so everything depends on that Mac staying up.",
		secretHelp: {
			server_url:
				"Where BlueBubbles Server is listening, e.g. http://192.168.1.10:1234. It must be reachable from wherever the Ryu gateway runs.",
			password:
				"The server password set in BlueBubbles Server → Settings. Sent on every request, so treat it like a token.",
		},
		warning:
			"Inbound iMessages arrive by webhook, so BlueBubbles Server must be pointed at the tokenized webhook URL reported by the Gateway for this channel (BlueBubbles Server → Settings → Webhooks). Typing indicators, read receipts and tapback reactions additionally need the BlueBubbles Private API helper installed on the Mac — without it the bot can still send and receive plain messages and media.",
	},
};

/**
 * Everything a bot does beyond "which agent, which model" — who may talk to it,
 * how it behaves while working, and what its profile says.
 *
 * Shared by the view and the save payload so the two can never drift: a field
 * the form can edit is a field the server is sent. Platforms that cannot honour
 * a setting simply ignore it (WhatsApp has no command menu, iMessage has no
 * threads), which keeps this one flat shape for every channel type.
 */
export interface ChannelBehaviorSettings {
	/** Sender ids admitted without pairing. */
	dmAllowlist: string[];
	/** Who may DM the bot, and how a stranger enrols. */
	dmPolicy: DmPolicy;
	/** Group/chat ids the bot will answer in. */
	groupAllowlist: string[];
	/** Whether the bot answers in groups at all. */
	groupPolicy: GroupPolicy;
	/** Sender ids admitted inside groups. */
	groupUserAllowlist: string[];
	/** Add lightweight 👀/✅/❌ reactions around a turn where supported. */
	lifecycleReactions: boolean;
	/** Send Ryu's first welcome without waiting for a user message. */
	proactiveOpening: boolean;
	/** Direct-chat id that may receive the first welcome. */
	proactiveTarget: string | null;
	/** Longer description shown in an empty chat (Telegram caps at 512). */
	profileDescription: string | null;
	/** Display name pushed to the platform. */
	profileName: string | null;
	/** Short bio on the profile page (Telegram caps at 120). */
	profileShortBio: string | null;
	/** Publish Ryu's command menu where the platform has one. */
	publishCommands: boolean;
	/** Optional provider emoji → Learning feedback mapping. */
	reactionLearning: ReactionLearningSettings;
	/** Render replies as platform rich text where supported. */
	richText: boolean;
	/** Mark inbound messages read (WhatsApp / iMessage). */
	sendReadReceipts: boolean;
	/** Stream partial output where the platform supports drafts. */
	streaming: boolean;
	/** Answer inside a thread on the triggering message (Discord). */
	threadReplies: boolean;
	/** Show a typing indicator while the agent is working. */
	typingIndicator: boolean;
	/** When to answer with synthesized speech as well as text. */
	voiceReply: VoiceReplyMode;
}

/** The settings a freshly-created bot starts with. */
export function defaultBehaviorSettings(): ChannelBehaviorSettings {
	return {
		dmPolicy: DEFAULT_DM_POLICY,
		groupPolicy: DEFAULT_GROUP_POLICY,
		dmAllowlist: [],
		groupAllowlist: [],
		groupUserAllowlist: [],
		lifecycleReactions: true,
		proactiveOpening: false,
		proactiveTarget: null,
		typingIndicator: true,
		publishCommands: true,
		richText: true,
		streaming: false,
		voiceReply: DEFAULT_VOICE_REPLY_MODE,
		threadReplies: false,
		sendReadReceipts: true,
		profileName: null,
		profileShortBio: null,
		profileDescription: null,
		reactionLearning: defaultReactionLearningSettings(),
	};
}

/**
 * Which behaviour settings are worth showing for a platform.
 *
 * A control the platform cannot honour is worse than a missing one — it reads
 * as a promise. Telegram is the only platform with a native command menu or
 * rich text; only Discord opens a thread per message; only WhatsApp and
 * iMessage have read receipts.
 */
export function supportedSettings(channelType: ChannelType): {
	commandMenu: boolean;
	profile: boolean;
	reactionLearning: boolean;
	readReceipts: boolean;
	richText: boolean;
	streaming: boolean;
	threadReplies: boolean;
	typing: boolean;
} {
	return {
		commandMenu: channelType === "telegram",
		richText: channelType === "telegram" || channelType === "slack",
		streaming: channelType === "telegram",
		threadReplies: channelType === "discord",
		readReceipts:
			channelType === "whatsapp" ||
			channelType === "whatsapp_personal" ||
			channelType === "bluebubbles",
		// Slack cannot send a true typing indicator and Telegram's expires in 5s,
		// but both have SOMETHING; iMessage needs the Private API helper.
		typing: true,
		profile: channelType === "telegram" || channelType === "discord",
		reactionLearning: channelType === "telegram",
	};
}

/** A channel config as the view needs it. */
export interface ChannelConfigView extends ChannelBehaviorSettings {
	agentId: string | null;
	/** Warning shown when the persisted binding no longer resolves to an agent. */
	bindingWarning?: string | null;
	channelType: ChannelType;
	/** Ryu-managed credentials are dedicated to one managed node, never shared. */
	credentialSource?: "ryu_managed" | "customer";
	enabled: boolean;
	/** When the bot replies in a group chat (mentions-only vs every message). */
	groupReplyMode: GroupReplyMode;
	id: string;
	managedBotId?: string | null;
	managedBotUsername?: string | null;
	managedProvisioningState?: "ready" | "awaiting_provider" | null;
	model: string | null;
	name: string;
	platformOptions?: Record<string, unknown>;
	provisionedServerId?: string | null;
	/** Credential keys already stored server-side (shown as "set"). */
	secrets: Record<string, string>;
	systemPrompt: string | null;
	/** Team this bot routes to instead of a single agent (lead orchestrates
	 * the members). Mutually exclusive with agentId. */
	teamId: string | null;
}

const TELEGRAM_BOT_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;
const DISCORD_APPLICATION_ID_PATTERN = /^\d{15,20}$/;

/** Build the public Telegram entry point for a node's dedicated bot. */
export function managedTelegramBotUrl(
	username: string | null | undefined
): string | null {
	const normalized = username?.trim().replace(/^@+/, "") ?? "";
	return TELEGRAM_BOT_USERNAME_PATTERN.test(normalized)
		? `https://t.me/${encodeURIComponent(normalized)}`
		: null;
}

/** Build Discord's standard app-install link for a node's dedicated bot. */
export function managedDiscordInstallUrl(
	applicationId: string | null | undefined
): string | null {
	const normalized = applicationId?.trim() ?? "";
	return DISCORD_APPLICATION_ID_PATTERN.test(normalized)
		? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(normalized)}`
		: null;
}

/** Payload the container persists on save (create or update). */
export interface ChannelSavePayload extends ChannelBehaviorSettings {
	agentId: string | null;
	channelType: ChannelType;
	enabled: boolean;
	groupReplyMode: GroupReplyMode;
	model: string | null;
	name: string;
	platformOptions: Record<string, unknown>;
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
	/** Whether the current caller may delete channel configurations. */
	canDelete?: boolean;
	channels: ChannelConfigView[];
	error?: string | null;
	/** Platform selected when a deep-linked app opens the new-channel form. */
	initialChannelType?: ChannelType;
	/** Seed the "new channel" form open. */
	initialNew?: boolean;
	/** Seed selection for storyboard determinism (e.g. the "edit" variant). */
	initialSelectedId?: string | null;
	loading?: boolean;
	onDelete?: (id: string) => boolean | Promise<boolean>;
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

interface FormState extends ChannelBehaviorSettings {
	agentId: string;
	channelType: ChannelType;
	enabled: boolean;
	existingSecretKeys: string[];
	groupReplyMode: GroupReplyMode;
	model: string;
	name: string;
	platformOptionInputs: Record<string, string>;
	secrets: Record<string, string>;
	systemPrompt: string;
}

const DEFAULT_AGENT = "__default__";
// Sentinel prefix on the unified target <select> value so a team selection is
// distinguishable from an agent id (the two come from different id namespaces).
const TEAM_PREFIX = "team:";

function emptyForm(channelType: ChannelType = "telegram"): FormState {
	return {
		channelType,
		name: "",
		agentId: DEFAULT_AGENT,
		model: "",
		systemPrompt: "",
		groupReplyMode: DEFAULT_GROUP_REPLY_MODE,
		enabled: false,
		secrets: {},
		platformOptionInputs: {},
		existingSecretKeys: [],
		...defaultBehaviorSettings(),
	};
}

/** Pull the behaviour settings off a stored config, defaulting any the server
 *  did not send (a bot saved before the field existed). */
function behaviorFromConfig(
	c: Partial<ChannelBehaviorSettings>
): ChannelBehaviorSettings {
	const defaults = defaultBehaviorSettings();
	return {
		dmPolicy: c.dmPolicy ?? defaults.dmPolicy,
		groupPolicy: c.groupPolicy ?? defaults.groupPolicy,
		dmAllowlist: c.dmAllowlist ?? defaults.dmAllowlist,
		groupAllowlist: c.groupAllowlist ?? defaults.groupAllowlist,
		groupUserAllowlist: c.groupUserAllowlist ?? defaults.groupUserAllowlist,
		lifecycleReactions: c.lifecycleReactions ?? defaults.lifecycleReactions,
		proactiveOpening: c.proactiveOpening ?? defaults.proactiveOpening,
		proactiveTarget: c.proactiveTarget ?? defaults.proactiveTarget,
		typingIndicator: c.typingIndicator ?? defaults.typingIndicator,
		publishCommands: c.publishCommands ?? defaults.publishCommands,
		richText: c.richText ?? defaults.richText,
		streaming: c.streaming ?? defaults.streaming,
		voiceReply: c.voiceReply ?? defaults.voiceReply,
		threadReplies: c.threadReplies ?? defaults.threadReplies,
		sendReadReceipts: c.sendReadReceipts ?? defaults.sendReadReceipts,
		profileName: c.profileName ?? defaults.profileName,
		profileShortBio: c.profileShortBio ?? defaults.profileShortBio,
		profileDescription: c.profileDescription ?? defaults.profileDescription,
		reactionLearning: c.reactionLearning ?? defaults.reactionLearning,
	};
}

function platformOptionInputsFromConfig(
	channelType: ChannelType,
	options: Record<string, unknown> | undefined
): Record<string, string> {
	const inputs: Record<string, string> = {};
	for (const field of PLATFORM_OPTION_FIELDS[channelType] ?? []) {
		const value = options?.[field.key];
		if (Array.isArray(value)) {
			inputs[field.key] = value
				.filter((entry): entry is string => typeof entry === "string")
				.join(", ");
		} else if (typeof value === "string" || typeof value === "number") {
			inputs[field.key] = String(value);
		} else if (typeof value === "boolean") {
			inputs[field.key] = value ? "true" : "false";
		}
	}
	return inputs;
}

function parsePlatformOptions(
	channelType: ChannelType,
	inputs: Record<string, string>
): Record<string, unknown> {
	const options: Record<string, unknown> = {};
	for (const field of PLATFORM_OPTION_FIELDS[channelType] ?? []) {
		const raw = inputs[field.key]?.trim() ?? "";
		if (!raw) {
			continue;
		}
		if (field.kind === "boolean") {
			if (raw === "true" || raw === "false") {
				options[field.key] = raw === "true";
			}
			continue;
		}
		if (field.kind === "number") {
			const value = Number(raw);
			if (Number.isFinite(value)) {
				options[field.key] = value;
			}
			continue;
		}
		if (field.kind === "list") {
			options[field.key] = raw
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			continue;
		}
		options[field.key] = raw;
	}
	return options;
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
		platformOptionInputs: platformOptionInputsFromConfig(
			c.channelType,
			c.platformOptions
		),
		existingSecretKeys: Object.keys(c.secrets ?? {}),
		...behaviorFromConfig(c),
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

	// Sidebar / deep-link navigation remounts are rare; still re-seed when the
	// manage route switches channel id or opens create.
	useEffect(() => {
		setSelectedId(initialSelectedId);
		setIsNew(initialNew);
	}, [initialSelectedId, initialNew]);

	const selected = channels.find((c) => c.id === selectedId) ?? null;

	useEffect(() => {
		if (isNew) {
			setForm(emptyForm(initialChannelType));
		} else if (selected) {
			setForm(formFromConfig(selected));
		}
		setFormError(null);
	}, [selected, isNew, initialChannelType]);

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
		}
	}, [form, isNew, selected, requiredKeys, onSave]);

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
					{error ? <p className="text-destructive text-sm">{error}</p> : null}
					{selected?.bindingWarning ? (
						<Alert>
							<AlertTitle>Agent binding needs attention</AlertTitle>
							<AlertDescription>{selected.bindingWarning}</AlertDescription>
						</Alert>
					) : null}
					{selected?.credentialSource === "ryu_managed" ? (
						<Alert>
							<AlertTitle>
								{selected.managedProvisioningState === "ready"
									? "Dedicated Ryu-managed bot"
									: "Managed bot setup is waiting"}
							</AlertTitle>
							<AlertDescription>
								{selected.managedProvisioningState === "ready" ? (
									<>
										{selected.managedBotUsername
											? `@${selected.managedBotUsername.replace(/^@+/, "")} is dedicated to this managed node. `
											: "This bot is dedicated to this managed node. "}
										It is not shared with another customer. To use your own bot,
										paste its token below and save; provider ownership transfer
										is not automatic.
										{managedBotActionUrl ? (
											<div className="mt-3 flex flex-wrap items-center gap-2">
												<a
													className={buttonVariants({
														size: "sm",
														variant: "outline",
													})}
													data-slot="button"
													href={managedBotActionUrl}
													rel="noopener noreferrer"
													target="_blank"
												>
													{selected.channelType === "telegram"
														? "Open in Telegram"
														: "Install in Discord"}
												</a>
												<span className="text-muted-foreground text-xs">
													{selected.channelType === "telegram"
														? "Open the bot, then press Start."
														: "Choose a server where you have Manage Server permission."}
												</span>
											</div>
										) : null}
									</>
								) : (
									"Ryu reserved this node's Telegram/Discord channel slot, but no company bot credential is available yet. Paste your own token below to use this channel now."
								)}
							</AlertDescription>
						</Alert>
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
									channelType: e.target.value as ChannelType,
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
						<p className="text-muted-foreground text-xs">
							{managedBotReady
								? "Ryu has already connected this dedicated bot to your managed node. Leave the field blank to keep it, or paste your own token below to switch credentials."
								: setup.note}
						</p>
						{requiredKeys.map((key) => {
							const isSet = form.existingSecretKeys.includes(key);
							const help = setup.secretHelp[key];
							const isManagedBotToken = managedBotReady && key === "bot_token";
							return (
								<div className="space-y-1.5" key={key}>
									<Label htmlFor={`secret-${key}`}>
										{isManagedBotToken
											? "Replace with your own bot token (optional)"
											: (SECRET_LABELS[key] ?? key)}
									</Label>
									<Input
										aria-describedby={help ? `secret-${key}-help` : undefined}
										autoComplete="off"
										id={`secret-${key}`}
										name={`secret-${key}`}
										onChange={(e) =>
											setForm((f) => ({
												...f,
												secrets: { ...f.secrets, [key]: e.target.value },
											}))
										}
										placeholder={
											isManagedBotToken
												? "Leave blank to keep the Ryu-managed bot"
												: isSet
													? "•••••••• (unchanged)"
													: "Paste value…"
										}
										type={
											key === "openwa_url" || key === "webhook_url"
												? "url"
												: "password"
										}
										value={form.secrets[key] ?? ""}
									/>
									{isManagedBotToken ? (
										<p
											className="text-muted-foreground text-xs"
											id={`secret-${key}-help`}
										>
											Saving a token here changes this channel to
											customer-managed credentials. Provider ownership transfer
											is not automatic.
										</p>
									) : help ? (
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
						{optionalKeys.length > 0 || platformOptionFields.length > 0 ? (
							<div className="space-y-3 border-t pt-3">
								<div>
									<p className="font-medium text-sm">Advanced delivery</p>
									<p className="text-muted-foreground text-xs">
										Optional settings stay with this channel, so another bot can
										use different delivery, mention, and thread behavior.
									</p>
								</div>
								{optionalKeys.map((key) => {
									const isSet = form.existingSecretKeys.includes(key);
									const help = setup.secretHelp[key];
									const isBoolean = key === "self_chat_only";
									return (
										<div className="space-y-1.5" key={key}>
											<Label htmlFor={`secret-${key}`}>
												{SECRET_LABELS[key] ?? key}
											</Label>
											<Input
												aria-describedby={
													help ? `secret-${key}-help` : undefined
												}
												autoComplete="off"
												id={`secret-${key}`}
												name={`secret-${key}`}
												onChange={(e) =>
													setForm((f) => ({
														...f,
														secrets: { ...f.secrets, [key]: e.target.value },
													}))
												}
												placeholder={
													isSet
														? "•••••••• (unchanged)"
														: isBoolean
															? "true or false"
															: "Leave blank for default…"
												}
												type={
													isBoolean ||
													[
														"webhook_bind",
														"webhook_path",
														"graph_version",
														"channel_ids",
													].includes(key)
														? "text"
														: "password"
												}
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
								{platformOptionFields.map((field) => (
									<div className="space-y-1.5" key={field.key}>
										<Label htmlFor={`platform-option-${field.key}`}>
											{field.label}
										</Label>
										<Input
											aria-describedby={`platform-option-${field.key}-help`}
											id={`platform-option-${field.key}`}
											inputMode={
												field.kind === "number" ? "numeric" : undefined
											}
											onChange={(e) =>
												setForm((f) => ({
													...f,
													platformOptionInputs: {
														...f.platformOptionInputs,
														[field.key]: e.target.value,
													},
												}))
											}
											placeholder={
												field.kind === "boolean"
													? "true or false"
													: field.kind === "list"
														? "id1, id2"
														: "Leave blank for default…"
											}
											type={field.kind === "url" ? "url" : "text"}
											value={form.platformOptionInputs[field.key] ?? ""}
										/>
										<p
											className="text-muted-foreground text-xs"
											id={`platform-option-${field.key}-help`}
										>
											{field.help}
										</p>
									</div>
								))}
							</div>
						) : null}
						<p className="text-muted-foreground text-xs">
							Values are stored encrypted and never shown again. On edit, leave
							a field blank to keep the stored value.
						</p>
					</div>

					{/* Hard external prerequisite (today: WhatsApp's public webhook). */}
					{setup.warning ? (
						<Alert>
							<AlertTitle>Before you connect</AlertTitle>
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

					<div className="space-y-3 rounded-lg border bg-card p-4">
						<div>
							<p className="font-medium text-sm">Who can talk to it</p>
							<p className="text-muted-foreground text-xs">
								A bot token lets anyone who finds the bot spend your
								completions, so inbound is closed to strangers by default.
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="channel-dm-policy">Direct messages</Label>
							<NativeSelect
								id="channel-dm-policy"
								onChange={(e) =>
									setForm((f) => ({
										...f,
										dmPolicy: e.target.value as DmPolicy,
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
									A new person gets a one-time code and is held until you
									approve it, so they can ask for access themselves instead of
									you hunting for their id.
								</p>
							) : null}
							{form.dmPolicy === "open" ? (
								<p className="text-destructive text-xs">
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
										groupPolicy: e.target.value as GroupPolicy,
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
								There is no pairing flow for a group — one member typing at the
								bot is not consent from the whole room.
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="channel-group-allowlist">
								Allowed group/chat IDs
							</Label>
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
								Used when Groups is set to the allowlist policy. Discord's
								watched channels are admitted automatically as well.
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
								Optional sender-level exception for Telegram, Slack, Discord,
								and BlueBubbles groups.
							</p>
						</div>
					</div>

					<div className="space-y-3 rounded-lg border bg-card p-4">
						<p className="font-medium text-sm">Behaviour</p>

						<div className="space-y-3 rounded-md border border-dashed p-3">
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="text-sm">Say hello first</p>
									<p className="text-muted-foreground text-xs">
										Let Ryu introduce itself and ask what to do next when this
										bot is ready. It waits for a local model to finish
										installing.
									</p>
								</div>
								<Switch
									aria-label="Send a welcome message first"
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
										setForm((f) => ({
											...f,
											proactiveTarget: e.target.value || null,
										}))
									}
									placeholder="The approved chat address or phone number"
									value={form.proactiveTarget ?? ""}
								/>
								<p className="text-muted-foreground text-xs">
									Use a chat that is already approved for this bot. Ryu never
									guesses a recipient or sends this to every chat.
								</p>
							</div>
						</div>

						{supported.typing ? (
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="text-sm">Typing indicator</p>
									<p className="text-muted-foreground text-xs">
										Show that the bot is working while the agent runs.
									</p>
								</div>
								<Switch
									aria-label="Typing indicator"
									checked={form.typingIndicator}
									onCheckedChange={(v) =>
										setForm((f) => ({ ...f, typingIndicator: v }))
									}
								/>
							</div>
						) : null}

						<div className="flex items-center justify-between gap-4">
							<div>
								<p className="text-sm">Lifecycle reactions</p>
								<p className="text-muted-foreground text-xs">
									Acknowledge received, completed, and failed turns with
									reactions where the platform supports them.
								</p>
							</div>
							<Switch
								aria-label="Lifecycle reactions"
								checked={form.lifecycleReactions}
								onCheckedChange={(v) =>
									setForm((f) => ({ ...f, lifecycleReactions: v }))
								}
							/>
						</div>

						{supported.reactionLearning ? (
							<div className="space-y-3 rounded-md border border-dashed p-3">
								<div className="flex items-center justify-between gap-4">
									<div>
										<p className="text-sm">Reaction learning</p>
										<p className="text-muted-foreground text-xs">
											Use reactions on Ryu's replies as Good response / Bad
											response feedback. It is off by default and only accepts
											exact replies.
										</p>
									</div>
									<Switch
										aria-label="Enable reaction learning"
										checked={form.reactionLearning.enabled}
										onCheckedChange={(v) =>
											setForm((f) => ({
												...f,
												reactionLearning: {
													...f.reactionLearning,
													enabled: v,
												},
											}))
										}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="channel-positive-emojis">
										Good response emojis
									</Label>
									<Input
										disabled={!form.reactionLearning.enabled}
										id="channel-positive-emojis"
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
									<Label htmlFor="channel-negative-emojis">
										Bad response emojis
									</Label>
									<Input
										disabled={!form.reactionLearning.enabled}
										id="channel-negative-emojis"
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

						{supported.commandMenu ? (
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="text-sm">Publish command menu</p>
									<p className="text-muted-foreground text-xs">
										Offer the same slash commands and skills the desktop chat
										does, in the platform's own command menu.
									</p>
								</div>
								<Switch
									aria-label="Publish command menu"
									checked={form.publishCommands}
									onCheckedChange={(v) =>
										setForm((f) => ({ ...f, publishCommands: v }))
									}
								/>
							</div>
						) : null}

						{supported.richText ? (
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="text-sm">Rich text replies</p>
									<p className="text-muted-foreground text-xs">
										Send headings, lists and tables natively instead of raw
										markdown.
									</p>
								</div>
								<Switch
									aria-label="Rich text replies"
									checked={form.richText}
									onCheckedChange={(v) =>
										setForm((f) => ({ ...f, richText: v }))
									}
								/>
							</div>
						) : null}

						{supported.streaming ? (
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="text-sm">Streaming drafts</p>
									<p className="text-muted-foreground text-xs">
										Show a draft while the reply is generated. Direct messages
										only — the platform rejects drafts in groups.
									</p>
								</div>
								<Switch
									aria-label="Streaming drafts"
									checked={form.streaming}
									onCheckedChange={(v) =>
										setForm((f) => ({ ...f, streaming: v }))
									}
								/>
							</div>
						) : null}

						{supported.threadReplies ? (
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="text-sm">Reply in a thread</p>
									<p className="text-muted-foreground text-xs">
										Open a thread on each message so a busy channel stays
										readable and each thread keeps its own history.
									</p>
								</div>
								<Switch
									aria-label="Reply in a thread"
									checked={form.threadReplies}
									onCheckedChange={(v) =>
										setForm((f) => ({ ...f, threadReplies: v }))
									}
								/>
							</div>
						) : null}

						{supported.readReceipts ? (
							<div className="flex items-center justify-between gap-4">
								<div>
									<p className="text-sm">Read receipts</p>
									<p className="text-muted-foreground text-xs">
										Mark messages read when the bot picks them up.
									</p>
								</div>
								<Switch
									aria-label="Read receipts"
									checked={form.sendReadReceipts}
									onCheckedChange={(v) =>
										setForm((f) => ({ ...f, sendReadReceipts: v }))
									}
								/>
							</div>
						) : null}

						<div className="space-y-1.5">
							<Label htmlFor="channel-voice-reply">Voice replies</Label>
							<NativeSelect
								id="channel-voice-reply"
								onChange={(e) =>
									setForm((f) => ({
										...f,
										voiceReply: e.target.value as VoiceReplyMode,
									}))
								}
								value={form.voiceReply}
							>
								{VOICE_REPLY_MODES.map((mode) => (
									<NativeSelectOption key={mode} value={mode}>
										{VOICE_REPLY_LABELS[mode]}
									</NativeSelectOption>
								))}
							</NativeSelect>
							<p className="text-muted-foreground text-xs">
								Voice messages you send are transcribed either way. A spoken
								reply is sent alongside the text, never instead of it.
								{form.channelType === "whatsapp" && form.voiceReply !== "never"
									? " WhatsApp cannot carry Ryu's generated audio, so replies there stay text-only."
									: ""}
							</p>
						</div>
					</div>

					{supported.profile ? (
						<div className="space-y-3 rounded-lg border bg-card p-4">
							<div>
								<p className="font-medium text-sm">Profile</p>
								<p className="text-muted-foreground text-xs">
									Pushed to the platform when the gateway starts. Leave a field
									blank to keep whatever the bot already has.
								</p>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="channel-profile-name">Display name</Label>
								<Input
									id="channel-profile-name"
									onChange={(e) =>
										setForm((f) => ({
											...f,
											profileName: e.target.value || null,
										}))
									}
									placeholder="Leave blank to keep the current name"
									value={form.profileName ?? ""}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="channel-profile-bio">
									Short bio ({(form.profileShortBio ?? "").length}/120)
								</Label>
								<Input
									id="channel-profile-bio"
									maxLength={120}
									onChange={(e) =>
										setForm((f) => ({
											...f,
											profileShortBio: e.target.value || null,
										}))
									}
									placeholder="Shown on the bot's profile page"
									value={form.profileShortBio ?? ""}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="channel-profile-description">
									Description ({(form.profileDescription ?? "").length}/512)
								</Label>
								<Textarea
									id="channel-profile-description"
									maxLength={512}
									onChange={(e) =>
										setForm((f) => ({
											...f,
											profileDescription: e.target.value || null,
										}))
									}
									placeholder="Shown in an empty chat, before the first message"
									rows={3}
									value={form.profileDescription ?? ""}
								/>
							</div>
						</div>
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
