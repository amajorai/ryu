import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["index.ts"],
	format: ["esm"],
	dts: false,
	clean: true,
	shims: true,
	banner: { js: "#!/usr/bin/env node" },
});
