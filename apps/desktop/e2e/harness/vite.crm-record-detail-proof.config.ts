import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	define: { "process.env": {} },
	resolve: {
		alias: [
			{
				find: "@/src/hooks/useApps.ts",
				replacement: path.resolve(harnessDir, "crm-record-detail-use-apps.ts"),
			},
			{
				find: "@/src/hooks/useActiveNode.ts",
				replacement: path.resolve(
					harnessDir,
					"crm-record-detail-use-active-node.ts"
				),
			},
			{ find: "@", replacement: desktopRoot },
		],
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5299,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-crm-record-detail-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "crm-record-detail-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
