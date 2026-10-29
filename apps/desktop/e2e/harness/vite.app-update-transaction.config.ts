import { mergeConfig } from "vite";
import harness from "./vite.harness.config.ts";

export default mergeConfig(harness, {
	cacheDir: "../../node_modules/.vite-app-update-transaction",
	optimizeDeps: {
		entries: ["app-update-transaction-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
});
