import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeConfig } from "vite";
import base from "./vite.harness.config.ts";

const baselineSource = process.env.RYU_NODE_MENU_BASELINE;
export default mergeConfig(base, {
	plugins: baselineSource
		? [
				{
					name: "node-menu-baseline",
					enforce: "pre",
					transform(_code: string, id: string) {
						if (id.endsWith("/src/components/shell/NodeSelector.tsx")) {
							return readFileSync(baselineSource, "utf8");
						}
					},
				},
			]
		: [],
	// Off the checkout and off a fixed /tmp: TMPDIR or the env override decide.
	cacheDir:
		process.env.RYU_NODE_MENU_PERFORMANCE_VITE_CACHE ??
		path.join(tmpdir(), "ryu-node-menu-performance-cache"),
	optimizeDeps: {
		entries: ["node-selector-status-story.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: { port: 5214, strictPort: true, watch: null, hmr: false },
});
