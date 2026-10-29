// packages/services/src/tools/adapters/ryu-agent.ts
//
// `toRyuAgentTools(ryu, options)`: the registry's tools as @ryuhq/sdk tool
// runnables (the shape `defineTool` returns: `{ kind: "tool", id, name,
// description, schema, needsApproval, code, run }`), keyed by tool name.
// Pass the record as `tools` to an @ryuhq/sdk `Agent`. The shape is written
// out here, so @ryuhq/services has no dependency on @ryuhq/sdk.
//
// `schema` is the tool's zod schema as JSON Schema; `run` parses the input
// with the zod schema itself and resolves to the SDK's `{ data, error, meta }`
// result as plain JSON, so a rejected argument or a service error reaches the
// model as `error.code` and `error.message` instead of ending the run.
// `needsApproval` makes the Agent ask its approval handler first; by default
// every tool that is not read-only or is open-world asks. `run` passes the
// Agent's abort signal (`runnableContext.signal`) to the tool, so aborting a
// run also stops a waiting tool (box_exec, notify_request_approval,
// managed_agents_list_events with wait).
//
// These tools run in your own process with your Ryu client. They cannot be
// packed into a plugin: `code` (the sandbox form `ryu pack` ships) only
// throws an error saying so.

import type { Ryu } from "../../ryu.ts";
import { type RyuToolJsonSchema, ryuToolJsonSchema } from "../json-schema.ts";
import { type RyuToolSelection, selectRyuTools } from "../registry.ts";
import {
	type RyuToolResultJSON,
	runRyuTool,
	toToolResultJson,
} from "../run.ts";
import type { RyuToolAnnotations, RyuToolContext } from "../types.ts";
import { needsApproval, type RyuToolApprovalOption } from "./approval.ts";

/** One registry tool as an @ryuhq/sdk tool runnable. */
export interface RyuAgentTool {
	/** The tool's effects, as in MCP. Not read by the Agent loop. */
	readonly annotations: RyuToolAnnotations;
	/** A sandbox body that throws: these tools run in-process only. */
	readonly code: string;
	readonly description: string;
	/** The registry tool name, e.g. `notify_publish`. */
	readonly id: string;
	readonly kind: "tool";
	/** The human title, e.g. "Publish a Notify event". */
	readonly name: string;
	/** Whether the Agent asks its approval handler before running the tool. */
	readonly needsApproval: boolean;
	/**
	 * Runs the tool; resolves to `{ data, error, meta }` and never rejects for
	 * a service error. `context.signal` (the Agent's) cancels the call.
	 */
	run(input: unknown, context?: unknown): Promise<RyuToolResultJSON>;
	readonly schema: RyuToolJsonSchema;
}

/** Options for {@link toRyuAgentTools}. */
export interface RyuAgentToolsOptions extends RyuToolSelection {
	/** Which tools the Agent asks approval for. Default: every tool that is not read-only or is open-world. */
	readonly needsApproval?: RyuToolApprovalOption;
}

/** The abort signal in the context the Agent passes to `run`, if any. */
function signalOf(context: unknown): RyuToolContext {
	if (typeof context !== "object" || context === null) {
		return {};
	}
	const { signal } = context as { signal?: Partial<AbortSignal> };
	const usable =
		typeof signal?.aborted === "boolean" &&
		typeof signal.addEventListener === "function";
	return usable ? { signal: signal as AbortSignal } : {};
}

function sandboxBody(name: string): string {
	const message = `${name} is an @ryuhq/services tool: it runs in-process with a Ryu client and cannot be packed into a plugin.`;
	return `throw new Error(${JSON.stringify(message)});`;
}

/**
 * The service tools for `ryu` as @ryuhq/sdk Agent tools, keyed by tool name.
 * Read-only tools only unless `readOnly: false`.
 */
export function toRyuAgentTools(
	ryu: Ryu,
	options: RyuAgentToolsOptions = {}
): Record<string, RyuAgentTool> {
	const tools: Record<string, RyuAgentTool> = {};
	for (const tool of selectRyuTools(ryu, options)) {
		tools[tool.name] = {
			kind: "tool",
			id: tool.name,
			name: tool.title,
			description: tool.description,
			schema: ryuToolJsonSchema(tool),
			annotations: tool.annotations,
			needsApproval: needsApproval(tool, options.needsApproval),
			code: sandboxBody(tool.name),
			run: async (input, context) =>
				toToolResultJson(await runRyuTool(ryu, tool, input, signalOf(context))),
		};
	}
	return tools;
}
