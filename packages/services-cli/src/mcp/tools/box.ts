// packages/services-cli/src/mcp/tools/box.ts
//
// Ryu Box MCP tools. The definitions (names, descriptions, zod schemas,
// annotations and bodies) live in the @ryuhq/services tool registry,
// packages/services/src/tools/box.ts, which `toAiSdkTools` and
// `toRyuAgentTools` read too; this module registers them on the MCP server.

import type { Ryu } from "@ryuhq/services";
import { BOX_TOOLS } from "@ryuhq/services/tools";
import { registerRegistryTools } from "../register.ts";
import type { ServiceToolRegistrar } from "../registry.ts";

/** Registers the Ryu Box tools. Called only when Ryu Box is configured. */
export function registerBoxTools(server: ServiceToolRegistrar, ryu: Ryu): void {
	registerRegistryTools(server, ryu, BOX_TOOLS);
}
