import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.ts", manifest: "src/manifest.ts", cli: "src/cli.ts" },
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	external: ["zod", "@ryu/sdk-native"],
	shims: true,
});
