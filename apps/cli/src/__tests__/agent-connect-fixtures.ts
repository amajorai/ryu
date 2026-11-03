// Shared by the `ryu connect` entry and config tests: one Core MCP URL and
// token, and each agent's inline entry built from them.

import {
	type AgentTarget,
	findAgent,
	type JsonObject,
} from "../cli/agentConnect.ts";

export const MCP_URL = "http://127.0.0.1:7980/mcp/ryu";
export const TOKEN = "ryu_test_token";

export function agent(id: string): AgentTarget {
	const found = findAgent(id);
	if (!found) {
		throw new Error(`missing agent ${id}`);
	}
	return found;
}

export function inlineEntry(id: string): JsonObject {
	return agent(id).buildEntry({
		mcpUrl: MCP_URL,
		token: TOKEN,
		tokenMode: "inline",
	});
}
