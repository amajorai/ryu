// packages/services-cli/src/mcp/tools/gateway.ts
//
// Ryu Gateway MCP tools. The definitions (names, descriptions, zod schemas,
// annotations and bodies) live in the @ryuhq/services tool registry,
// packages/services/src/tools/gateway.ts, which `toAiSdkTools` and
// `toRyuAgentTools` read too; this module registers them on the MCP server.

import type { Ryu } from "@ryuhq/services";
import { GATEWAY_TOOLS } from "@ryuhq/services/tools";
import { registerRegistryTools } from "../register.ts";
import type { ServiceToolRegistrar } from "../registry.ts";

export { MAX_CHAT_TOOL_TOKENS } from "@ryuhq/services/tools";

/** Registers the Ryu Gateway tools. Called only when Ryu Gateway is configured. */
export function registerGatewayTools(
	server: ServiceToolRegistrar,
	ryu: Ryu
): void {
	registerRegistryTools(server, ryu, GATEWAY_TOOLS);
}
