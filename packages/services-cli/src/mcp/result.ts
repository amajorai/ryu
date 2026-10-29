// packages/services-cli/src/mcp/result.ts
//
// How service tools answer. Success is `structuredContent: { data, meta }`
// plus the same JSON as text (for hosts that only read text). Failure is
// `isError: true` with `{ error: RyuError.toJSON() }`, which never contains
// keys or request headers, so an agent can branch on `error.code`. The hint
// stays in its own `hint` field, so `message` is the error's message without
// it (as in the SDK tool projection, `toToolErrorJson`).

import type { CallToolResult } from "@modelcontextprotocol/server";
import {
	messageWithoutHint,
	type RyuError,
	type RyuResponseMeta,
	type RyuService,
} from "@ryuhq/services";
import { settleToolCall } from "@ryuhq/services/tools";
import { mcpHintText } from "../hints.ts";
import { toJson } from "../output.ts";
import { withProgram } from "../program.ts";
import { unwrapSettled } from "../settled.ts";

/** Round-trips `value` through JSON so structured content is plain data (no Dates, bigints or class instances). */
function plain(value: unknown): unknown {
	const text = toJson(value);
	return text === undefined ? null : (JSON.parse(text) as unknown);
}

/** A successful tool result carrying `{ data, meta }`. */
export function toolSuccess(
	data: unknown,
	meta: RyuResponseMeta | null
): CallToolResult {
	const structured = plain({ data: data ?? null, meta }) as Record<
		string,
		unknown
	>;
	return {
		content: [{ type: "text", text: toJson(structured, 2) ?? "null" }],
		structuredContent: structured,
	};
}

/** Options for {@link toolFailure} and {@link runTool}. */
export interface ToolResultOptions {
	/**
	 * The command line that runs the server (`ryu-cli services` when a host
	 * delegates); hints name it in place of `ryu-services`.
	 */
	readonly program?: string;
}

/**
 * A failed tool result carrying `{ error }` from `RyuError.toJSON()`, with
 * `message` stripped of the hint that `hint` already carries. The SDK's
 * `new Ryu()` option advice is reworded for an MCP server entry (see
 * `mcpHintText`): its env block is the only setting the person can change.
 */
export function toolFailure(
	error: RyuError,
	options: ToolResultOptions = {}
): CallToolResult {
	const bare = messageWithoutHint(error);
	const message = withProgram(
		error.code === "configuration_error"
			? // The advice goes with the hint when there is one, else here.
				mcpHintText(error.service, bare, { advice: !error.hint })
			: bare,
		options.program
	);
	const json = {
		...error.toJSON(),
		message,
		...(error.hint
			? {
					hint: withProgram(
						mcpHintText(error.service, error.hint),
						options.program
					),
				}
			: {}),
	};
	const structured = plain({ error: json }) as Record<string, unknown>;
	return {
		content: [{ type: "text", text: toJson(structured, 2) ?? "null" }],
		structuredContent: structured,
		isError: true,
	};
}

/**
 * Runs a tool body and formats its outcome. Return the facade promise itself
 * (`() => ryu.notify.publish(input)`), or `settled(call)` (from
 * `@ryuhq/services/tools` or this CLI) from an async body, so the result
 * carries the call's meta. Anything thrown becomes a RyuError for `service`.
 * The settling is the registry's `settleToolCall`, which the AI SDK and
 * @ryuhq/sdk adapters use too.
 */
export async function runTool(
	service: RyuService,
	call: () => unknown,
	options: ToolResultOptions = {}
): Promise<CallToolResult> {
	const outcome = unwrapSettled(await settleToolCall(service, call));
	return outcome.error === null
		? toolSuccess(outcome.data, outcome.meta)
		: toolFailure(outcome.error, options);
}

export {
	type CollectedEvents,
	type CollectOptions,
	collectEvents,
} from "@ryuhq/services/tools";
