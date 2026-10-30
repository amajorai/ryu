import {
	type ChannelType,
	DEFAULT_GROUP_REPLY_MODE,
	defaultReactionLearningSettings,
	type GroupReplyMode,
	type ReactionLearningSettings,
} from "@ryu/blocks/desktop/channels.tsx";
import type { Dispatch, SetStateAction } from "react";

export const DEFAULT_AGENT = "__default__";
export const TEAM_PREFIX = "team:";

/**
 * How the user supplies a Telegram bot. `managed` is the zero-token path (Ryu's
 * manager bot has Telegram create a bot the user owns — Bot API 9.6); `manual` is
 * the original paste-a-@BotFather-token form, kept as the fallback for every case
 * the managed path can't serve (support switched off server-side, an existing bot
 * the user wants to reuse).
 *
 * Only Telegram has two ways in; every other platform renders `manual` only.
 */
export type ConnectMode = "managed" | "manual";

export interface FormState {
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
export function splitBinding(value: string) {
	if (value.startsWith(TEAM_PREFIX)) {
		return { agentId: null, teamId: value.slice(TEAM_PREFIX.length) };
	}
	return {
		agentId: value === DEFAULT_AGENT ? null : value,
		teamId: null,
	};
}

export function emptyForm(): FormState {
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

export type SetFormState = Dispatch<SetStateAction<FormState>>;
