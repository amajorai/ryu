import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	plugins: [react()],
	root: harnessDir,
	clearScreen: false,
	server: {
		host: "127.0.0.1",
		port: 5183,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-billing-transactional-emails-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(
				harnessDir,
				"billing-transactional-emails-proof.html"
			),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
