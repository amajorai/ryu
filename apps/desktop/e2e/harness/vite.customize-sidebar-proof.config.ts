import { tmpdir } from "node:os";
import { mergeConfig } from "vite";
import base from "./vite.app-sidebar-interactions-proof.config.ts";
export default mergeConfig(base, {
	cacheDir: `${tmpdir()}/ryu-customize-sidebar-cache`,
	server: { port: 5489 },

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
