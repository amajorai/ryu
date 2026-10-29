import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.agent-health-scorecard-proof.config.ts";

export default mergeConfig(
	base,
	defineConfig({
		assetsInclude: ["**/*.glb"],
		cacheDir: path.resolve(tmpdir(), "ryu-agent-edit-loading-proof-vite"),
		optimizeDeps: {
			entries: [
				path.resolve(import.meta.dirname, "agent-edit-loading-proof.html"),
			],
			esbuildOptions: { target: "esnext" },
		},
		server: { port: 5388, strictPort: true },
		build: {
			outDir:
				process.env.RYU_AGENT_EDIT_PROOF_OUTPUT ??
				path.resolve(import.meta.dirname, "dist-agent-edit-loading-proof"),
			rollupOptions: {
				input: path.resolve(
					import.meta.dirname,
					"agent-edit-loading-proof.html"
				),
			},
		},
	})
);
