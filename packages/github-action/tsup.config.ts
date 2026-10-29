import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		action: "src/entry.ts",
		index: "src/index.ts",
	},
	bundle: true,
	clean: true,
	dts: true,
	format: ["cjs"],
	minify: false,
	noExternal: ["@actions/core", "@ryuhq/core-client", "zod"],
	platform: "node",
	splitting: false,
	target: "node20",
	outExtension: () => ({ js: ".cjs" }),
});
