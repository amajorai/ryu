import { readFileSync } from "node:fs";
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
	cacheDir: "/tmp/ryu-node-menu-performance-cache",
	optimizeDeps: {
		entries: ["node-selector-status-story.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: { port: 5214, strictPort: true, watch: null, hmr: false },
});
