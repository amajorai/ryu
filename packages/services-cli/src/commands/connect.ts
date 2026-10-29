// packages/services-cli/src/commands/connect.ts
//
// `ryu-services connect …`: Ryu Connect is itself an MCP server, so the CLI
// has no Connect commands (the management routes are being rewritten) and
// prints a pointer to the service's own `/mcp` endpoint instead. The export
// names and types are frozen.

import type { CommandIo, ServiceCommand } from "../registry.ts";

/** The page for Connect's account and trigger management routes (not in ryu-services). */
const CONNECT_TRIGGERS_DOCS_URL =
	"https://docs.ryuhq.com/docs/standalone/connect-api-triggers";

/** Every `ryu-services connect` command (none: see {@link connectPointer}). */
export const connectCommands: readonly ServiceCommand[] = [];

/** `RYU_CONNECT_URL` without query, fragment or credentials, or its placeholder. */
function connectBase(env: CommandIo["env"]): string {
	const raw = env.RYU_CONNECT_URL?.trim();
	if (!raw) {
		return "$RYU_CONNECT_URL";
	}
	try {
		const url = new URL(raw);
		return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
	} catch {
		return "$RYU_CONNECT_URL";
	}
}

/** One sentence naming Connect's MCP endpoint and header. Never prints the key. */
export function connectMcpHint(env: CommandIo["env"]): string {
	return `Point your MCP client at ${connectBase(env)}/mcp with the header "Authorization: Bearer $RYU_CONNECT_API_KEY".`;
}

/** What `ryu-services connect` prints: where Connect's MCP endpoint is. Never prints the key. */
export function connectPointer(env: CommandIo["env"]): string {
	return [
		"Ryu Connect is an MCP server itself, so ryu-services has no connect commands.",
		connectMcpHint(env),
		`Account and trigger management are HTTP routes that take the separate management key: ${CONNECT_TRIGGERS_DOCS_URL}`,
	].join("\n");
}
