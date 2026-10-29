import { tmpdir } from "node:os";
import { mergeConfig } from "vite";
import base from "./vite.harness.config.ts";
export default mergeConfig(base, {
	cacheDir: `${tmpdir()}/ryu-startup-bootstrap-cache`,
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["desktop-startup-bootstrap-proof.html"],
	},
	server: { port: 5490, strictPort: true, watch: null, hmr: false },
});
