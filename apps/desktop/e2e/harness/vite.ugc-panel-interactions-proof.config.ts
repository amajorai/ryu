import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: { "process.env": {} },
	root: harnessDir,
	clearScreen: false,
	resolve: {
		alias: [
			{
				find: "@/src/hooks/useActiveNode.ts",
				replacement: path.resolve(
					harnessDir,
					"ugc-panel-interactions-stubs.ts"
				),
			},
			{
				find: "@/src/hooks/useApps.ts",
				replacement: path.resolve(
					harnessDir,
					"ugc-panel-interactions-stubs.ts"
				),
			},
			{ find: "@", replacement: desktopRoot },
		],
	},
	server: {
		host: "127.0.0.1",
		port: 5428,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-ugc-panel-interactions-proof"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "ugc-panel-interactions-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
