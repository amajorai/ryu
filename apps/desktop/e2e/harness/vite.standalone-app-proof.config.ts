import { defineConfig, mergeConfig } from "vite";
import harness from "./vite.harness.config.ts";

export default mergeConfig(
	harness,
	defineConfig({
		server: {
			host: "127.0.0.1",
			port: 5199,
			strictPort: true,
		},

		optimizeDeps: { esbuildOptions: { target: "esnext" } },
	})
);
