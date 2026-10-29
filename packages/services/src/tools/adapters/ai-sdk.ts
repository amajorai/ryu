// packages/services/src/tools/adapters/ai-sdk.ts
//
// `toAiSdkTools(ryu, options)`: the registry's tools in the Vercel AI SDK
// tool shape, `{ description, inputSchema, execute }`, keyed by tool name.
// The shape is written out here, so @ryuhq/services does not depend on the
// `ai` package; pass the record as `tools` to `generateText`, `streamText`
// or an AI SDK agent. `inputSchema` is the tool's zod schema, which the AI
// SDK reads directly.
//
// `execute` never throws for a service failure: it resolves to the compact
// `{ data, error, meta }` JSON (see run.ts), so the model sees `error.code`,
// `error.message` and `error.hint`. Argument validation is the AI SDK's: it
// parses the model's arguments with `inputSchema` before calling `execute`,
// so arguments the schema rejects reach the model as the AI SDK's own tool
// error (AI_InvalidToolInputError / a type validation error), not as
// `invalid_arguments`. `execute` still parses its input, so a direct call
// with bad arguments resolves to `invalid_arguments`. The AI SDK's
// `abortSignal` is passed to the tool.

import type * as z from "zod";
import type { Ryu } from "../../ryu.ts";
import { type RyuToolSelection, selectRyuTools } from "../registry.ts";
import {
	type RyuToolResultJSON,
	runRyuTool,
	toToolResultJson,
} from "../run.ts";
import type { RyuToolAnnotations } from "../types.ts";
import { needsApproval, type RyuToolApprovalOption } from "./approval.ts";

/** The per-call options the AI SDK passes to `execute` (the fields read here). */
export interface AiSdkToolCallOptions {
	readonly abortSignal?: AbortSignal;
	readonly toolCallId?: string;
}

/** One registry tool in the Vercel AI SDK tool shape. */
export interface RyuAiSdkTool {
	/** The tool's effects, as in MCP. Not read by the AI SDK. */
	readonly annotations: RyuToolAnnotations;
	readonly description: string;
	/** Runs the tool; resolves to `{ data, error, meta }` and never rejects for a service error. */
	execute(
		input: unknown,
		options?: AiSdkToolCallOptions
	): Promise<RyuToolResultJSON>;
	readonly inputSchema: z.ZodObject;
	/**
	 * Whether a person should approve the call first. AI SDK releases that
	 * support tool approval read this property; others ignore it.
	 */
	readonly needsApproval: boolean;
	readonly title: string;
}

/** Options for {@link toAiSdkTools}. */
export interface AiSdkToolsOptions extends RyuToolSelection {
	/** Which tools carry `needsApproval: true`. Default: every tool that is not read-only or is open-world. */
	readonly needsApproval?: RyuToolApprovalOption;
}

/**
 * The service tools for `ryu` as Vercel AI SDK tools, keyed by tool name.
 * Read-only tools only unless `readOnly: false`.
 */
export function toAiSdkTools(
	ryu: Ryu,
	options: AiSdkToolsOptions = {}
): Record<string, RyuAiSdkTool> {
	const tools: Record<string, RyuAiSdkTool> = {};
	for (const tool of selectRyuTools(ryu, options)) {
		tools[tool.name] = {
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
			needsApproval: needsApproval(tool, options.needsApproval),
			execute: async (input, callOptions) =>
				toToolResultJson(
					await runRyuTool(ryu, tool, input, {
						...(callOptions?.abortSignal === undefined
							? {}
							: { signal: callOptions.abortSignal }),
					})
				),
		};
	}
	return tools;
}
