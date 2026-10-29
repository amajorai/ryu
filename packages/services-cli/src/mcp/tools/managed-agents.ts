// packages/services-cli/src/mcp/tools/managed-agents.ts
//
// Ryu Managed Agents MCP tools. The definitions (names, descriptions, zod schemas,
// annotations and bodies) live in the @ryuhq/services tool registry,
// packages/services/src/tools/managed-agents.ts, which `toAiSdkTools` and
// `toRyuAgentTools` read too; this module registers them on the MCP server.

import type { Ryu } from "@ryuhq/services";
import { MANAGED_AGENTS_TOOLS } from "@ryuhq/services/tools";
import { registerRegistryTools } from "../register.ts";
import type { ServiceToolRegistrar } from "../registry.ts";

/** The open approval requests of a session; the CLI's `sessions pending-approvals` reads it too. */
export { listPendingApprovals } from "@ryuhq/services/tools";

/** Registers the Ryu Managed Agents tools. Called only when Ryu Managed Agents is configured. */
export function registerManagedAgentsTools(
	server: ServiceToolRegistrar,
	ryu: Ryu
): void {
	registerRegistryTools(server, ryu, MANAGED_AGENTS_TOOLS);
}
