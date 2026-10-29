// packages/services-cli/src/mcp/tools/passport.ts
//
// Ryu Passport MCP tools. The definitions (names, descriptions, zod schemas,
// annotations and bodies) live in the @ryuhq/services tool registry,
// packages/services/src/tools/passport.ts, which `toAiSdkTools` and
// `toRyuAgentTools` read too; this module registers them on the MCP server.

import type { Ryu } from "@ryuhq/services";
import { PASSPORT_TOOLS } from "@ryuhq/services/tools";
import { registerRegistryTools } from "../register.ts";
import type { ServiceToolRegistrar } from "../registry.ts";

/** Registers the Ryu Passport tools. Called only when Ryu Passport is configured. */
export function registerPassportTools(
	server: ServiceToolRegistrar,
	ryu: Ryu
): void {
	registerRegistryTools(server, ryu, PASSPORT_TOOLS);
}
