import { mergeConfig } from "vite";
import base from "./vite.harness.config.ts";
export default mergeConfig(base, {
	cacheDir: "/tmp/ryu-keep-awake-cache",
	optimizeDeps: {
		entries: ["keep-awake-proof.html", "acp-settings-scope-proof.html"],

		esbuildOptions: { target: "esnext" },
	},
	server: { port: 5236, strictPort: true, watch: null, hmr: false },
});
