// packages/services-cli/src/mcp/tools/sites.ts
//
// Ryu Sites MCP tools. The definitions (names, descriptions, zod schemas,
// annotations and bodies) live in the @ryuhq/services tool registry,
// packages/services/src/tools/sites.ts, which `toAiSdkTools` and
// `toRyuAgentTools` read too; this module registers them on the MCP server.

import type { Ryu } from "@ryuhq/services";
import { SITES_TOOLS } from "@ryuhq/services/tools";
import { registerRegistryTools } from "../register.ts";
import type { ServiceToolRegistrar } from "../registry.ts";

/** Registers the Ryu Sites tools. Called only when Ryu Sites is configured. */
export function registerSitesTools(
	server: ServiceToolRegistrar,
	ryu: Ryu
): void {
	registerRegistryTools(server, ryu, SITES_TOOLS);
}
