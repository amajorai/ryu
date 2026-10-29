import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	build: {
		emptyOutDir: true,
		outDir: path.resolve(harnessDir, "dist-read-receipts-proof"),
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "read-receipts-proof.html"),
		},
	},
	clearScreen: false,
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: { "@": desktopRoot },
	},
	root: harnessDir,
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_E2E_PORT ?? "5182"),
		strictPort: true,
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
