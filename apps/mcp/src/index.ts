#!/usr/bin/env bun
// Ryu Core MCP server (stdio transport).
//
// Exposes a running Ryu Core node's API to any MCP host (Claude Desktop,
// Cursor, etc.). The host talks JSON-RPC over stdio; we translate tool calls
// into typed @ryuhq/core-client requests against one Core node built from env.
//
// stdout is reserved for JSON-RPC. All diagnostics go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadToken, runLogin, runLogout, runWhoami } from "./auth.ts";
import { buildTarget } from "./target.ts";
import { registerRyuTools } from "./tools.ts";

// Start the stdio MCP server. stdout is reserved for JSON-RPC, so every
// diagnostic line goes to stderr.
const serve = async (): Promise<void> => {
	const target = buildTarget();

	const server = new McpServer({
		name: "ryu-mcp",
		version: "0.1.0",
	});

	registerRyuTools(server, target);

	const transport = new StdioServerTransport();
	await server.connect(transport);

	const signedIn = loadToken();
	const who = signedIn?.name || signedIn?.email || "not signed in";
	process.stderr.write(
		`ryu-mcp connected (Core target: ${target.url}, user: ${who})\n`
	);
};

const USAGE = "Usage: ryu-mcp [serve|login|logout|whoami]\n";

// argv dispatch: a bare invocation (or `serve`) runs the stdio server; the auth
// subcommands run the device-authorization flow against Core's proxy and exit.
const main = async (): Promise<void> => {
	const command = process.argv[2];
	switch (command) {
		case undefined:
		case "serve":
			await serve();
			return;
		case "login":
			await runLogin();
			return;
		case "logout":
			await runLogout();
			return;
		case "whoami":
			await runWhoami();
			return;
		default:
			process.stderr.write(`Unknown command: ${command}\n${USAGE}`);
			process.exit(1);
	}
};

main().catch((err) => {
	process.stderr.write(`ryu-mcp failed: ${String(err)}\n`);
	process.exit(1);
});
