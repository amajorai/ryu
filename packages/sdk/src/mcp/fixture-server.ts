/**
 * Fixture MCP stdio server used by bridge.test.ts.
 *
 * Registers one test Runnable ("greet") and serves over stdin/stdout.
 * Spawn with: bun run packages/sdk/src/mcp/fixture-server.ts
 */
import { McpServer } from "./server";

const server = new McpServer().register({
	name: "greet",
	description: "Returns a greeting for the given name.",
	inputSchema: {
		type: "object",
		properties: { name: { type: "string", description: "Name to greet" } },
		required: ["name"],
	},
	run: (args: unknown) => {
		const a = args as { name?: string };
		return Promise.resolve({ message: `Hello, ${a.name ?? "world"}!` });
	},
});

await server.serve();
