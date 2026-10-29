import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	plugins: [react()],
	root: harnessDir,
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_APPEARANCE_E2E_PORT ?? "5194"),
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "appearance-bridge-dist"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "appearance-bridge-story.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
