// packages/services-cli/src/commands/gateway.ts
//
// `ryu-services gateway …`: Ryu Gateway commands (design §10).
//
//   models
//   chat "<prompt>" --model M [--system S] [--max-tokens N] [--temperature T] [--stream]
//
// Configuration comes from RYU_GATEWAY_URL (default http://127.0.0.1:7981)
// and RYU_GATEWAY_TOKEN, or --base-url / --api-key. A chat completion is
// never retried on a 5xx, so a failed `chat` may still have been billed by
// the provider.

import type { GatewayChatMessage } from "@ryuhq/services";
import { gatewayChatBody } from "@ryuhq/services/tools";
import {
	booleanFlag,
	CliUsageError,
	numberFlag,
	requireStringFlag,
	stringFlag,
} from "../args.ts";
import { listPage } from "../list-output.ts";
import type { CommandContext, ServiceCommand } from "../registry.ts";

function rejectArgs(ctx: CommandContext): void {
	if (ctx.args.length > 0 || ctx.rest.length > 0) {
		throw new CliUsageError(
			`Unexpected argument ${JSON.stringify([...ctx.args, ...ctx.rest][0])}.`
		);
	}
}

/** The single `"<prompt>"` positional. */
function promptArg(ctx: CommandContext): string {
	const [prompt, ...extra] = ctx.args;
	if (prompt === undefined || prompt.trim() === "") {
		throw new CliUsageError('A prompt is required: chat "<prompt>" --model M.');
	}
	if (extra.length > 0 || ctx.rest.length > 0) {
		throw new CliUsageError(
			'Pass the prompt as one quoted argument, e.g. chat "Summarize this" --model M.'
		);
	}
	return prompt;
}

/** The chat body built from the prompt and flags (the `gateway_chat` tool's builder). */
export const chatBody = gatewayChatBody;

function maxTokensFlag(ctx: CommandContext): number | undefined {
	const value = numberFlag(ctx.flags, "max-tokens");
	if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
		throw new CliUsageError("--max-tokens must be a positive integer.");
	}
	return value;
}

function temperatureFlag(ctx: CommandContext): number | undefined {
	const value = numberFlag(ctx.flags, "temperature");
	if (value !== undefined && !(value >= 0 && value <= 2)) {
		throw new CliUsageError("--temperature must be between 0 and 2.");
	}
	return value;
}

/** The assistant text of a completion, for human output. */
function assistantText(completion: {
	choices: { message: GatewayChatMessage }[];
}): string {
	const content = completion.choices[0]?.message.content;
	if (typeof content === "string") {
		return content;
	}
	return JSON.stringify(completion, null, 2);
}

function chat(ctx: CommandContext): unknown {
	const prompt = promptArg(ctx);
	const body = chatBody({
		maxTokens: maxTokensFlag(ctx),
		model: requireStringFlag(ctx.flags, "model"),
		prompt,
		system: stringFlag(ctx.flags, "system"),
		temperature: temperatureFlag(ctx),
	});
	if (booleanFlag(ctx.flags, "stream")) {
		return ctx.ryu.gateway.chat.completions.stream(body);
	}
	const completion = ctx.ryu.gateway.chat.completions.create({
		...body,
		stream: false,
	});
	// `--json` keeps the facade promise so the output carries the call's meta.
	return ctx.json ? completion : completion.then(assistantText);
}

/** Every `ryu-services gateway` command. */
export const gatewayCommands: readonly ServiceCommand[] = [
	{
		path: ["models"],
		summary: "List the models this Gateway can route to.",
		readOnly: true,
		run: (ctx) => {
			rejectArgs(ctx);
			return listPage(ctx, ctx.ryu.gateway.models.list(), {
				items: (page) => page.data,
				noun: "models",
			});
		},
	},
	{
		path: ["chat"],
		usage: '"<prompt>"',
		summary:
			"Send one chat completion and print the reply (--json for the full completion). Never retried on a 5xx.",
		example: 'ryu-services gateway chat "Say hello" --model <id>',
		flags: {
			model: {
				type: "string",
				valueName: "id",
				description: "The model id; see `gateway models`.",
				required: true,
			},
			system: {
				type: "string",
				valueName: "text",
				description: "A system message sent before the prompt.",
			},
			"max-tokens": {
				type: "number",
				valueName: "n",
				description: "The most tokens to generate.",
			},
			temperature: {
				type: "number",
				valueName: "t",
				description: "Sampling temperature, 0-2.",
			},
			stream: {
				type: "boolean",
				description: "Stream the completion and print one JSON chunk per line.",
			},
		},
		run: chat,
	},
];
