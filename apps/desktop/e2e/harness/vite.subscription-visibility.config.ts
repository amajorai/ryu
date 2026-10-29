import path from "node:path";
import { mergeConfig } from "vite";
import base from "./vite.harness.config.ts";
export default mergeConfig(base, {
	cacheDir: path.resolve(
		import.meta.dirname,
		"../../../../node_modules/.cache/ryu-subscription-visibility-cache"
	),
	optimizeDeps: {
		entries: ["subscription-visibility-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: { port: 5219, strictPort: true, watch: null, hmr: false },
});
