import {
	isNativeBoolean,
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import type { AppRequestValue } from "@ryuhq/core-client/app-request-json.ts";
import {
	type ChannelType,
	DEFAULT_DM_POLICY,
	DEFAULT_GROUP_POLICY,
	DEFAULT_GROUP_REPLY_MODE,
	DEFAULT_VOICE_REPLY_MODE,
	type DmPolicy,
	defaultReactionLearningSettings,
	type GroupPolicy,
	type GroupReplyMode,
	PLATFORM_OPTION_FIELDS,
	type ReactionLearningSettings,
	type VoiceReplyMode,
} from "./channels-constants.ts";

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
	/** Show 👀 while a turn runs and ❌ if it fails, where reactions are supported. */
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
export function supportedSettings(channelType: ChannelType) {
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
	platformOptions?: Record<string, AppRequestValue>;
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
	platformOptions: AuthoredPlatformOptionValues;
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

export interface FormState extends ChannelBehaviorSettings {
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

export const DEFAULT_AGENT = "__default__";
// Sentinel prefix on the unified target <select> value so a team selection is
// distinguishable from an agent id (the two come from different id namespaces).
export const TEAM_PREFIX = "team:";

export function emptyForm(channelType: ChannelType = "telegram"): FormState {
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
export function behaviorFromConfig(
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

/** Authored form cells are always strings; option keys follow the mutable
 * platform field registry and may be extended by a host.
 */
interface PlatformOptionInputValues {
	[key: string]: string;
}

/** Values produced by the local form parser's four native field kinds. */
interface AuthoredPlatformOptionValues {
	[key: string]: string | number | boolean | string[];
}

function platformOptionInputsFromConfig(
	channelType: ChannelType,
	options: ChannelConfigView["platformOptions"]
): PlatformOptionInputValues {
	const inputs: PlatformOptionInputValues = {};
	for (const field of PLATFORM_OPTION_FIELDS[channelType] ?? []) {
		const value = options?.[field.key];
		if (Array.isArray(value)) {
			inputs[field.key] = value
				.filter((entry): entry is string => isNativeText(entry))
				.join(", ");
		} else if (isNativeText(value) || isNativeNumber(value)) {
			inputs[field.key] = String(value);
		} else if (isNativeBoolean(value)) {
			inputs[field.key] = value ? "true" : "false";
		}
	}
	return inputs;
}

export function parsePlatformOptions(
	channelType: ChannelType,
	inputs: PlatformOptionInputValues
): AuthoredPlatformOptionValues {
	const options: AuthoredPlatformOptionValues = {};
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

export function formFromConfig(c: ChannelConfigView): FormState {
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
