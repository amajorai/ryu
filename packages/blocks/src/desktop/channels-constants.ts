import { z } from "zod";

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
export const channelTypeInputSchema = z.enum(
	CHANNEL_TYPES
) satisfies z.ZodType<ChannelType>;

// When the bot replies inside a group/multi-user chat (DMs always reply).
// Mirrors GROUP_REPLY_MODES in packages/db/src/models/channel.model.ts.
export const GROUP_REPLY_MODES = ["mentions", "all"] as const;
export type GroupReplyMode = (typeof GROUP_REPLY_MODES)[number];
export const groupReplyModeInputSchema = z.enum(
	GROUP_REPLY_MODES
) satisfies z.ZodType<GroupReplyMode>;
export const DEFAULT_GROUP_REPLY_MODE: GroupReplyMode = "mentions";

export const GROUP_REPLY_LABELS = {
	mentions: "Only when mentioned",
	all: "Every message",
} satisfies Record<GroupReplyMode, string>;

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
export const dmPolicyInputSchema = z.enum(
	DM_POLICIES
) satisfies z.ZodType<DmPolicy>;
export const DEFAULT_DM_POLICY: DmPolicy = "pairing";

export const DM_POLICY_LABELS = {
	pairing: "Ask me to approve new people",
	allowlist: "Only people on my list",
	open: "Anyone (billed to you)",
	disabled: "Nobody — groups only",
} satisfies Record<DmPolicy, string>;

export const GROUP_POLICIES = ["allowlist", "open", "disabled"] as const;
export type GroupPolicy = (typeof GROUP_POLICIES)[number];
export const groupPolicyInputSchema = z.enum(
	GROUP_POLICIES
) satisfies z.ZodType<GroupPolicy>;
export const DEFAULT_GROUP_POLICY: GroupPolicy = "allowlist";

export const GROUP_POLICY_LABELS = {
	allowlist: "Only groups on my list",
	open: "Any group it's added to",
	disabled: "Never reply in groups",
} satisfies Record<GroupPolicy, string>;

// When the bot answers with synthesized speech as well as text.
export const VOICE_REPLY_MODES = ["never", "mirror", "always"] as const;
export type VoiceReplyMode = (typeof VOICE_REPLY_MODES)[number];
export const voiceReplyModeInputSchema = z.enum(
	VOICE_REPLY_MODES
) satisfies z.ZodType<VoiceReplyMode>;
export const DEFAULT_VOICE_REPLY_MODE: VoiceReplyMode = "never";

export const VOICE_REPLY_LABELS = {
	never: "Text only",
	mirror: "Speak back to voice messages",
	always: "Speak every reply",
} satisfies Record<VoiceReplyMode, string>;

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
export const REQUIRED_SECRETS = {
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
} satisfies Record<ChannelType, string[]>;

/** Optional per-channel transport settings. These are kept in the same
 * encrypted map so two WhatsApp records can listen on different local routes
 * without turning node-local webhook plumbing into a global setting. */
export const OPTIONAL_SECRETS = {
	telegram: ["webhook_secret"],
	slack: [],
	whatsapp: ["webhook_bind", "webhook_path", "graph_version"],
	whatsapp_personal: ["webhook_bind", "webhook_path", "self_chat_only"],
	discord: ["channel_ids"],
	bluebubbles: [],
} satisfies Record<ChannelType, string[]>;

type PlatformOptionKind = "boolean" | "list" | "number" | "text" | "url";

export interface PlatformOptionField {
	help: string;
	key: string;
	kind: PlatformOptionKind;
	label: string;
}

/** Non-secret transport and mention controls stored in platformOptions. */
/** The complete six-platform authoring port; entries remain optional. */
export interface PlatformOptionRegistry {
	bluebubbles?: PlatformOptionField[];
	discord?: PlatformOptionField[];
	slack?: PlatformOptionField[];
	telegram?: PlatformOptionField[];
	whatsapp?: PlatformOptionField[];
	whatsapp_personal?: PlatformOptionField[];
}

export const PLATFORM_OPTION_FIELDS: PlatformOptionRegistry = {
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
