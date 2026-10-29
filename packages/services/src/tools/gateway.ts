// packages/services/src/tools/gateway.ts
//
// Ryu Gateway tools (`gateway_*`): list_models and chat. `gateway_chat` sends
// the prompt to a model provider, which may bill for it, so it is open-world
// and not idempotent; it is never retried on a 5xx.

import * as z from "zod";
import type {
	GatewayChatCompletionParams,
	GatewayChatMessage,
} from "../gateway/namespace.ts";
import { READ, SEND } from "./annotations.ts";
import { toolOutput } from "./output.ts";
import { type AnyRyuTool, defineRyuTool } from "./types.ts";

/** The most tokens `gateway_chat` lets one call ask for. */
export const MAX_CHAT_TOOL_TOKENS = 32_768;

/** The Chat Completions body for one prompt (and an optional system message). */
export function gatewayChatBody(input: {
	maxTokens?: number;
	model: string;
	prompt: string;
	system?: string;
	temperature?: number;
}): GatewayChatCompletionParams & { messages: GatewayChatMessage[] } {
	const messages: GatewayChatMessage[] = [];
	if (input.system !== undefined) {
		messages.push({ content: input.system, role: "system" });
	}
	messages.push({ content: input.prompt, role: "user" });
	return {
		messages,
		model: input.model,
		...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
		...(input.temperature === undefined
			? {}
			: { temperature: input.temperature }),
	};
}

const chatInput = z.object({
	model: z
		.string()
		.min(1)
		.describe("A model id from gateway_list_models, e.g. openai/gpt-4o-mini."),
	prompt: z.string().min(1).describe("The user message."),
	system: z
		.string()
		.optional()
		.describe("An optional system message sent before the prompt."),
	maxTokens: z
		.int()
		.min(1)
		.max(MAX_CHAT_TOOL_TOKENS)
		.optional()
		.describe("The most tokens to generate."),
	temperature: z
		.number()
		.min(0)
		.max(2)
		.optional()
		.describe("Sampling temperature, 0-2."),
});

// Replies, mirroring the Gateway decoders (gateway/client.ts
// `gatewayModelListSchema`, `gatewayChatCompletionSchema`); output.test.ts
// keeps them equal.

/** `gateway_list_models` data. */
export const GATEWAY_MODEL_LIST_DATA = z.looseObject({
	data: z.array(
		z.looseObject({
			created: z.number().optional(),
			id: z.string(),
			object: z.string().optional(),
			owned_by: z.string().optional(),
		})
	),
	object: z.string().optional(),
});

/** `gateway_chat` data: an OpenAI-compatible `chat.completion`. */
export const GATEWAY_CHAT_COMPLETION_DATA = z.looseObject({
	created: z.number().optional(),
	id: z.string().optional(),
	model: z.string().optional(),
	object: z.string().optional(),
	usage: z
		.looseObject({
			completion_tokens: z.number().optional(),
			prompt_tokens: z.number().optional(),
			total_tokens: z.number().optional(),
		})
		.nullable()
		.optional(),
	choices: z.array(
		z.looseObject({
			finish_reason: z.string().nullable().optional(),
			index: z.number().optional(),
			message: z.looseObject({
				content: z
					.union([z.string(), z.array(z.record(z.string(), z.unknown()))])
					.nullable()
					.optional(),
				role: z.string(),
			}),
		})
	),
});

/** The Ryu Gateway tools. */
export const GATEWAY_TOOLS: readonly AnyRyuTool[] = [
	defineRyuTool({
		service: "gateway",
		name: "gateway_list_models",
		title: "List Gateway models",
		description:
			"Lists the models this Ryu Gateway can route to, in the OpenAI `{ object, data: [{ id, … }] }` shape.",
		inputSchema: z.object({}),
		annotations: READ,
		outputSchema: toolOutput(GATEWAY_MODEL_LIST_DATA),
		run: (ryu) => ryu.gateway.models.list(),
	}),
	defineRyuTool({
		service: "gateway",
		name: "gateway_chat",
		title: "Chat through the Gateway",
		description:
			"Sends one chat completion through Ryu Gateway and returns the OpenAI-compatible completion. The provider may bill for the call, and it is never retried on a server error.",
		inputSchema: chatInput,
		annotations: SEND,
		outputSchema: toolOutput(GATEWAY_CHAT_COMPLETION_DATA),
		run: (ryu, input) =>
			ryu.gateway.chat.completions.create({
				...gatewayChatBody(input),
				stream: false,
			}),
	}),
];
