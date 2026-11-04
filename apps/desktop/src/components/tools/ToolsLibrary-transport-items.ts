import type { LiteralMessage } from "@ryu/i18n/react";
import type { McpTransport } from "@/src/lib/api/mcp.ts";

/**
 * The MCP transport picker's labels, keyed by wire value. Passed as the
 * Select's `items` so the closed trigger shows "Local process (stdio)" in the
 * UI language rather than the raw "stdio".
 */
export function mcpTransportItems(
	tl: LiteralMessage
): Record<McpTransport, string> {
	return {
		stdio: tl("Local process (stdio)"),
		"streamable-http": tl("Streamable HTTP"),
		sse: tl("Legacy HTTP + SSE"),
	};
}
