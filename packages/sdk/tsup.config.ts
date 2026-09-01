import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		manifest: "src/manifest.ts",
		"agent-plugin": "src/agent-plugin.ts",
		cli: "src/cli.ts",
		agent: "src/agent/index.ts",
		action: "src/runnable/action.ts",
		model: "src/model/index.ts",
		mcp: "src/mcp/index.ts",
		"mcp/server": "src/mcp/server.ts",
		"mcp/client": "src/mcp/client.ts",
		plugin: "src/plugin/ryu-plugin.ts",
		runnable: "src/runnable/index.ts",
		builder: "src/builder.ts",
	},
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	external: ["zod", "@ryuhq/sdk-native", "@ryuhq/client"],
	shims: true,
});
