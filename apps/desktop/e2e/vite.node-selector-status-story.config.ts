import { tmpdir } from "node:os";
import path from "node:path";
import { mergeConfig } from "vite";

import base from "./harness/vite.node-menu-performance.config.ts";

const port = Number(process.env.RYU_NODE_SELECTOR_E2E_PORT ?? "5214");

export default mergeConfig(base, {
	cacheDir: path.join(tmpdir(), "ryu-cloudflared-node-selector-vite-cache"),
	optimizeDeps: { esbuildOptions: { target: "esnext" } },
	server: { port, strictPort: true },
});
