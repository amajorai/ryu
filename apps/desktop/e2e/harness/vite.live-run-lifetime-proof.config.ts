import { mergeConfig } from "vite";
import base from "./vite.harness.config.ts";
export default mergeConfig(base, {
	cacheDir: "/tmp/ryu-live-run-lifetime-cache",
	optimizeDeps: {
		entries: ["live-run-lifetime-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: { port: 5216, strictPort: true, watch: null, hmr: false },
});
