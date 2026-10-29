// packages/services-cli/src/mcp/tools/notify.ts
//
// Ryu Notify MCP tools. The definitions (names, descriptions, zod schemas,
// annotations and bodies) live in the @ryuhq/services tool registry,
// packages/services/src/tools/notify.ts, which `toAiSdkTools` and
// `toRyuAgentTools` read too; this module registers them on the MCP server.

import type { Ryu } from "@ryuhq/services";
import { NOTIFY_TOOLS } from "@ryuhq/services/tools";
import { registerRegistryTools } from "../register.ts";
import type { ServiceToolRegistrar } from "../registry.ts";

export {
	DEFAULT_APPROVAL_TOOL_TIMEOUT_MS,
	DEFAULT_APPROVAL_WAIT_MS,
	MAX_APPROVAL_TIMEOUT_MS,
	MAX_APPROVAL_WAIT_MS,
} from "@ryuhq/services/tools";

/** Registers the Ryu Notify tools. Called only when Ryu Notify is configured. */
export function registerNotifyTools(
	server: ServiceToolRegistrar,
	ryu: Ryu
): void {
	registerRegistryTools(server, ryu, NOTIFY_TOOLS);
}
