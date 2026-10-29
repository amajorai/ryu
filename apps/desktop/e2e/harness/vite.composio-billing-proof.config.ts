import { tmpdir } from "node:os";
import { mergeConfig } from "vite";
import base from "./vite.harness.config.ts";
export default mergeConfig(base, {
	cacheDir: `${tmpdir()}/ryu-composio-billing-vite-cache`,
	optimizeDeps: {
		entries: ["composio-billing-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: { port: 5273, strictPort: true, watch: null, hmr: false },
});
