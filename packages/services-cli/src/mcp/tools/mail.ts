// packages/services-cli/src/mcp/tools/mail.ts
//
// Ryu Mail MCP tools. The definitions (names, descriptions, zod schemas,
// annotations and bodies) live in the @ryuhq/services tool registry,
// packages/services/src/tools/mail.ts, which `toAiSdkTools` and
// `toRyuAgentTools` read too; this module registers them on the MCP server.

import type { Ryu } from "@ryuhq/services";
import { MAIL_TOOLS } from "@ryuhq/services/tools";
import { registerRegistryTools } from "../register.ts";
import type { ServiceToolRegistrar } from "../registry.ts";

/** Registers the Ryu Mail tools. Called only when Ryu Mail is configured. */
export function registerMailTools(
	server: ServiceToolRegistrar,
	ryu: Ryu
): void {
	registerRegistryTools(server, ryu, MAIL_TOOLS);
}
