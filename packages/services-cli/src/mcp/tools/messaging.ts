// packages/services-cli/src/mcp/tools/messaging.ts
//
// Ryu Messaging MCP tools. The definitions (names, descriptions, zod schemas,
// annotations and bodies) live in the @ryuhq/services tool registry,
// packages/services/src/tools/messaging.ts, which `toAiSdkTools` and
// `toRyuAgentTools` read too; this module registers them on the MCP server.

import type { Ryu } from "@ryuhq/services";
import { MESSAGING_TOOLS } from "@ryuhq/services/tools";
import { registerRegistryTools } from "../register.ts";
import type { ServiceToolRegistrar } from "../registry.ts";

export { MESSAGING_METADATA_MAX_ENTRIES } from "@ryuhq/services/tools";

/** Registers the Ryu Messaging tools. Called only when Ryu Messaging is configured. */
export function registerMessagingTools(
	server: ServiceToolRegistrar,
	ryu: Ryu
): void {
	registerRegistryTools(server, ryu, MESSAGING_TOOLS);
}
