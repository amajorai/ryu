import path from "node:path";
import harness from "./vite.harness.config.ts";

const harnessDir = path.resolve(import.meta.dirname);

export default {
	...harness,
	build: {
		...harness.build,
		outDir: "/private/tmp/ryu-agent-routines-interactions-build",
		emptyOutDir: true,
		rollupOptions: {
			...harness.build?.rollupOptions,
			input: path.resolve(harnessDir, "agent-routines-interactions.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
};
