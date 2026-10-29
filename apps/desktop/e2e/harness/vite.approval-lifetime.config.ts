import path from "node:path";
import { mergeConfig } from "vite";
import base from "./vite.harness.config.ts";

const config = mergeConfig(base, {
	cacheDir: "/tmp/ryu-approval-lifetime-cache",
	optimizeDeps: {
		entries: ["approval-lifetime-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: { port: 5237, strictPort: true, watch: null, hmr: false },
});

// Vite merges entry arrays; this fixture owns only the approval listener graph.
config.optimizeDeps = {
	...config.optimizeDeps,
	entries: ["approval-lifetime-proof.html"],
};

config.resolve = {
	...config.resolve,
	alias: [
		{
			find: "@/lib/auth-client.ts",
			replacement: path.resolve(
				import.meta.dirname,
				"approval-session-fixture.ts"
			),
		},
		{ find: "@", replacement: path.resolve(import.meta.dirname, "../..") },
	],
};
export default config;
