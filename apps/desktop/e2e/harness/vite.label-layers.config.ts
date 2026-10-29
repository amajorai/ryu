import { mergeConfig } from "vite";
import base from "./vite.harness.config.ts";
export default mergeConfig(base, {
	cacheDir: "/tmp/ryu-label-layers-cache",
	optimizeDeps: {
		entries: ["button-label-overflow-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: { port: 5221, strictPort: true, watch: null, hmr: false },
});
