import {
	CHANNEL_TYPES,
	GROUP_REPLY_MODES,
} from "@ryu/blocks/desktop/channels.tsx";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import type { ComponentProps } from "react";
import { z } from "zod";
import type { AddChannelDialog } from "../src/components/channels/AddChannelDialog.tsx";

export type AddChannelProofInput = Parameters<
	ComponentProps<typeof AddChannelDialog>["onCreate"]
>[0];
const channelFields = z.looseObject({
	agentId: z.string().nullable(),
	channelType: z.enum(CHANNEL_TYPES),
	enabled: z.boolean(),
	groupReplyMode: z.enum(GROUP_REPLY_MODES),
	model: z.string().nullable(),
	name: z.string(),
	proactiveOpening: z.boolean(),
	proactiveTarget: z.string().nullable(),
	reactionLearning: z.looseObject({
		allowGroup: z.boolean(),
		enabled: z.boolean(),
		negativeEmoji: z.array(z.string()),
		positiveEmoji: z.array(z.string()),
	}),
	secrets: z.record(z.string(), z.string()),
	systemPrompt: z.string().nullable(),
	teamId: z.string().nullable(),
}) satisfies z.ZodType<AddChannelProofInput>;
/** Complete actual onCreate callback input, retaining native JSON refs/extras. */
export const addChannelProofInputSchema = z.custom<AddChannelProofInput>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		channelFields.safeParse(value).success
);
const callsFields = z.array(addChannelProofInputSchema);
export const addChannelProofCallsSchema = z.custom<AddChannelProofInput[]>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		callsFields.safeParse(value).success
);
const failureFields = z.looseObject({ message: z.string() });
/** Complete private error body published by installCreateFixture in the spec. */
const failureSchema = z.custom<z.output<typeof failureFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		failureFields.safeParse(value).success
);
export function addChannelProofFailureTitle(
	value: Parameters<typeof failureSchema.safeParse>[0]
): string {
	const failure = failureSchema.safeParse(value);
	return failure.success ? failure.data.message : "Could not create channel";
}
export interface AddChannelProofState {
	calls: AddChannelProofInput[];
	nodeCreated: string[];
}
declare global {
	interface Window {
		__ADD_CHANNEL_PROOF__?: AddChannelProofState;
	}
}
