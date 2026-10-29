import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
	},
	plugins: [react()],
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	root: harnessDir,
	build: {
		emptyOutDir: true,
		outDir: path.resolve(
			harnessDir,
			"../../../../tmp/ryu-crash-boundary-proof"
		),
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "crash-boundary-proof.html"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_CRASH_PROOF_PORT ?? "5226"),
		strictPort: true,
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
