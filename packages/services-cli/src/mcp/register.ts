// packages/services-cli/src/mcp/register.ts
//
// `registerRegistryTools(server, ryu, tools)`: registers @ryuhq/services
// registry tools on a registrar, binding each body to `ryu`. Each
// `src/mcp/tools/<svc>.ts` calls it with its service's list; it lives apart
// from registry.ts so those modules and the registry's module list do not
// import each other.

import type { Ryu } from "@ryuhq/services";
import { type AnyRyuTool, ryuForToolCall } from "@ryuhq/services/tools";
import type { ServiceToolRegistrar } from "./registry.ts";

/**
 * Registers `tools` (registry definitions) on `server`, binding each body to
 * `ryu` with the MCP request's abort signal. What every `register<Svc>Tools`
 * does.
 */
export function registerRegistryTools(
	server: ServiceToolRegistrar,
	ryu: Ryu,
	tools: readonly AnyRyuTool[]
): void {
	for (const tool of tools) {
		server.tool({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			outputSchema: tool.outputSchema,
			annotations: tool.annotations,
			// The MCP request's signal reaches every facade call the body makes.
			run: (input, context) =>
				tool.run(ryuForToolCall(ryu, context), input, context),
		});
	}
}
