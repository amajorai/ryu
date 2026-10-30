import type { ChannelType } from "./channels-constants.ts";

/** Authored labels plus the existing mutable extension-key port. */
export interface ChannelSecretLabels {
	access_token: string;
	app_secret: string;
	app_token: string;
	bot_token: string;
	channel_ids: string;
	graph_version: string;
	openwa_api_key: string;
	openwa_session_id: string;
	openwa_url: string;
	password: string;
	phone_number_id: string;
	self_chat_only: string;
	server_url: string;
	verify_token: string;
	webhook_bind: string;
	webhook_path: string;
	webhook_secret: string;
	webhook_url: string;
	[secret: string]: string;
}

export const SECRET_LABELS: ChannelSecretLabels = {
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

export const CHANNEL_LABELS = {
	telegram: "Telegram",
	slack: "Slack",
	whatsapp: "WhatsApp Business (Cloud API)",
	whatsapp_personal: "WhatsApp Personal",
	discord: "Discord",
	bluebubbles: "iMessage (BlueBubbles)",
} satisfies Record<ChannelType, string>;

/** Per-platform setup guidance shown in the credentials card. */
export interface ChannelSetup {
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

interface ChannelSetupGuides {
	bluebubbles: ChannelSetup;
	discord: ChannelSetup;
	slack: ChannelSetup;
	telegram: ChannelSetup;
	whatsapp: ChannelSetup;
	whatsapp_personal: ChannelSetup;
}

export const CHANNEL_SETUP: ChannelSetupGuides = {
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
