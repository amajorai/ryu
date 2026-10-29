// apps/desktop/src/lib/api/channels.ts
//
// Typed client for channel-bot configuration (Telegram/Slack/WhatsApp/Discord,
// and iMessage via a BlueBubbles Server on the operator's Mac).
//
// Unlike every other desktop client module, this targets the identity/control
// plane server (:3000, BACKEND_URL) rather than a Core node — channel configs are
// a "what is allowed/configured" concern and live in the control plane
// (packages/api `/api/channels`, MongoDB), authenticated with the Better-Auth
// session bearer token. The gateway reads enabled configs at startup and runs the
// platform listeners (apps/gateway/src/channels/*), forwarding inbound messages
// to Core's POST /api/channels/run.
//
// Secrets are write-only: list/get responses mask them as "***". On edit we send
// only the secret fields the user actually changed (the server merges them).

import { activityJsonValueSchema } from "@ryuhq/core-client/activity.ts";
import { appRequestValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";

export const CHANNEL_TYPES = [
	"telegram",
	"slack",
	"whatsapp",
	"whatsapp_personal",
	"discord",
	"bluebubbles",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** When the bot replies inside a group chat (DMs always reply). */
export const GROUP_REPLY_MODES = ["mentions", "all"] as const;
export type GroupReplyMode = (typeof GROUP_REPLY_MODES)[number];

/** Who may DM the bot, and how a stranger enrols. See DM_POLICIES in
 *  packages/db/src/models/channel.model.ts — that is the enforcing copy. */
export const DM_POLICIES = [
	"pairing",
	"allowlist",
	"open",
	"disabled",
] as const;
export type DmPolicy = (typeof DM_POLICIES)[number];

/** Whether the bot answers in groups at all. */
export const GROUP_POLICIES = ["allowlist", "open", "disabled"] as const;
export type GroupPolicy = (typeof GROUP_POLICIES)[number];

/** When the bot answers with synthesized speech as well as text. */
export const VOICE_REPLY_MODES = ["never", "mirror", "always"] as const;
export type VoiceReplyMode = (typeof VOICE_REPLY_MODES)[number];

export type ChannelCredentialSource = "ryu_managed" | "customer";
export type ManagedChannelProvisioningState = "ready" | "awaiting_provider";

export interface ReactionLearningSettings {
	allowGroup: boolean;
	enabled: boolean;
	negativeEmoji: string[];
	positiveEmoji: string[];
}

/**
 * Per-bot behaviour settings: who may talk to it, how it behaves while working,
 * and what its profile says. Flat across every platform — a channel that cannot
 * honour a setting ignores it (WhatsApp has no command menu, iMessage has no
 * threads), which is why the form gates which controls it renders rather than
 * the wire shape varying by type.
 */
export interface ChannelBehavior {
	dmAllowlist: string[];
	dmPolicy: DmPolicy;
	groupAllowlist: string[];
	groupPolicy: GroupPolicy;
	groupUserAllowlist: string[];
	lifecycleReactions: boolean;
	/** Send Ryu's first welcome without waiting for a user message. */
	proactiveOpening: boolean;
	/** Direct-chat id that may receive the first welcome. */
	proactiveTarget: string | null;
	profileDescription: string | null;
	profileName: string | null;
	profileShortBio: string | null;
	publishCommands: boolean;
	/** Optional provider emoji → Learning feedback mapping. */
	reactionLearning?: ReactionLearningSettings;
	richText: boolean;
	sendReadReceipts: boolean;
	streaming: boolean;
	threadReplies: boolean;
	typingIndicator: boolean;
	voiceReply: VoiceReplyMode;
}

// The per-channel required-credential map and its field labels deliberately do
// NOT live here. This module once carried its own copy, which silently drifted
// from the gateway's real contract (it still demanded only 2 of WhatsApp's 4
// keys) while having zero consumers. The form's copy — the one that renders —
// is REQUIRED_SECRETS/SECRET_LABELS/CHANNEL_SETUP in
// packages/blocks/src/desktop/channels.tsx, and the enforcing copy is
// REQUIRED_SECRETS in packages/api/src/routers/channels.ts (the server guard,
// mirroring apps/gateway/src/channels/*.rs). Don't add a third.

export const CHANNEL_LABELS = {
	telegram: "Telegram",
	slack: "Slack",
	whatsapp: "WhatsApp Business (Cloud API)",
	whatsapp_personal: "WhatsApp Personal",
	discord: "Discord",
	bluebubbles: "iMessage (BlueBubbles)",
} satisfies Record<ChannelType, string>;

/** A channel config as returned by the server (secrets masked to "***"). */
export interface ChannelConfig extends Partial<ChannelBehavior> {
	agentId: string | null;
	channelType: ChannelType;
	createdAt: string;
	createdBy: string;
	credentialSource: ChannelCredentialSource;
	enabled: boolean;
	/** When the bot replies in a group chat (mentions-only vs every message). */
	groupReplyMode?: GroupReplyMode;
	id: string;
	managedBotId: string | null;
	managedBotUsername: string | null;
	managedProvisioningState: ManagedChannelProvisioningState | null;
	model: string | null;
	name: string;
	organizationId: string | null;
	platformOptions?: ChannelPlatformOptions;
	/** Node binding for Ryu-created credentials; null means org-global. */
	provisionedServerId: string | null;
	secrets: Record<string, string>;
	systemPrompt: string | null;
	/** Team this bot routes to instead of a single agent. Mutually exclusive
	 * with agentId — when set, the team's lead orchestrates its members. */
	teamId: string | null;
	updatedAt: string;
}

export interface ChannelInput extends Partial<ChannelBehavior> {
	agentId?: string | null;
	channelType: ChannelType;
	enabled?: boolean;
	groupReplyMode?: GroupReplyMode;
	model?: string | null;
	name: string;
	platformOptions?: ChannelPlatformOptions;
	/** Only the secret keys being set/changed; the server merges on update. */
	secrets?: Record<string, string>;
	systemPrompt?: string | null;
	teamId?: string | null;
}

const channelPlatformOptionFieldsSchema = z.record(
	z.string(),
	appRequestValueSchema
);
export const channelPlatformOptionsSchema = z.custom<
	z.output<typeof channelPlatformOptionFieldsSchema>
>(
	(value) =>
		appRequestValueSchema.safeParse(value).success &&
		channelPlatformOptionFieldsSchema.safeParse(value).success
);
export type ChannelPlatformOptions = z.output<
	typeof channelPlatformOptionsSchema
>;

// Full browser-safe maskChannelConfig projection from the database owner.
// Validate known fields without stripping future fields or original references.
function preserveChannelReply<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			activityJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const channelRecordFieldsSchema = z.object({
	agentId: z.string().nullable(),
	channelType: z.enum(CHANNEL_TYPES),
	createdAt: z.string(),
	createdBy: z.string(),
	credentialSource: z.enum(["ryu_managed", "customer"]),
	enabled: z.boolean(),
	groupReplyMode: z.enum(GROUP_REPLY_MODES).optional(),
	id: z.string(),
	managedBotId: z.string().nullable(),
	managedBotUsername: z.string().nullable(),
	managedProvisioningState: z.enum(["ready", "awaiting_provider"]).nullable(),
	model: z.string().nullable(),
	name: z.string(),
	organizationId: z.string().nullable(),
	platformOptions: channelPlatformOptionsSchema.optional(),
	provisionedServerId: z.string().nullable(),
	secrets: z.record(z.string(), z.string()),
	systemPrompt: z.string().nullable(),
	teamId: z.string().nullable(),
	updatedAt: z.string(),
	dmAllowlist: z.array(z.string()).optional(),
	dmPolicy: z.enum(DM_POLICIES).optional(),
	groupAllowlist: z.array(z.string()).optional(),
	groupPolicy: z.enum(GROUP_POLICIES).optional(),
	groupUserAllowlist: z.array(z.string()).optional(),
	lifecycleReactions: z.boolean().optional(),
	proactiveOpening: z.boolean().optional(),
	proactiveTarget: z.string().nullable().optional(),
	profileDescription: z.string().nullable().optional(),
	profileName: z.string().nullable().optional(),
	profileShortBio: z.string().nullable().optional(),
	publishCommands: z.boolean().optional(),
	reactionLearning: z
		.object({
			allowGroup: z.boolean(),
			enabled: z.boolean(),
			negativeEmoji: z.array(z.string()),
			positiveEmoji: z.array(z.string()),
		})
		.optional(),
	richText: z.boolean().optional(),
	sendReadReceipts: z.boolean().optional(),
	streaming: z.boolean().optional(),
	threadReplies: z.boolean().optional(),
	typingIndicator: z.boolean().optional(),
	voiceReply: z.enum(VOICE_REPLY_MODES).optional(),
});
export const channelConfigSchema = preserveChannelReply(
	channelRecordFieldsSchema
) satisfies z.ZodType<ChannelConfig>;
// Earlier control planes predate behavior fields; the page owns their existing
// fallback defaults. Validate every present field while preserving its absence.
const channelLegacyEmptyEnvelopeSchema = z.union([
	z.string(),
	z.boolean(),
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
	z.array(activityJsonValueSchema),
]);
const channelListReplySchema = preserveChannelReply(
	z.object({ channels: z.array(channelConfigSchema).nullish() })
);
const channelErrorReplySchema = z.object({
	message: activityJsonValueSchema.optional(),
	error: activityJsonValueSchema.optional(),
});

/** True when the user has a session token; channel CRUD requires sign-in. */
export function hasChannelAuth(): boolean {
	try {
		return Boolean(getActiveToken());
	} catch {
		return false;
	}
}

function authHeaders(): Headers {
	const headers = new Headers({ "Content-Type": "application/json" });
	try {
		const token = getActiveToken();
		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
		}
	} catch {
		// No storage — request will 401 and the UI prompts to sign in.
	}
	return headers;
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/channels`;

async function parseError(resp: Response): Promise<Error> {
	if (resp.status === 401) {
		return new Error("Sign in to manage channels.");
	}
	try {
		const body = channelErrorReplySchema.parse(await resp.json());
		const msg = body.message ?? body.error;
		if (msg) {
			return new Error(String(msg));
		}
	} catch {
		// Non-JSON body.
	}
	return new Error(`Request failed: ${resp.status}`);
}

export async function listChannels(): Promise<ChannelConfig[]> {
	const resp = await fetch(BASE, { headers: authHeaders() });
	if (!resp.ok) {
		throw await parseError(resp);
	}
	const payload = activityJsonValueSchema.parse(await resp.json());
	if (channelLegacyEmptyEnvelopeSchema.safeParse(payload).success) {
		return [];
	}
	const body = channelListReplySchema.parse(payload);
	return body.channels ?? [];
}

export async function createChannel(
	input: ChannelInput
): Promise<ChannelConfig> {
	const resp = await fetch(BASE, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw await parseError(resp);
	}
	return channelConfigSchema.parse(await resp.json());
}

export async function updateChannel(
	id: string,
	input: Partial<ChannelInput>
): Promise<ChannelConfig> {
	const resp = await fetch(`${BASE}/${id}`, {
		method: "PATCH",
		headers: authHeaders(),
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw await parseError(resp);
	}
	return channelConfigSchema.parse(await resp.json());
}

export async function deleteChannel(id: string): Promise<void> {
	const resp = await fetch(`${BASE}/${id}`, {
		method: "DELETE",
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await parseError(resp);
	}
}
