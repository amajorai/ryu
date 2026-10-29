import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	optimizeDeps: { esbuildOptions: { target: "esnext" } },
	cacheDir: `${tmpdir()}/ryu-crm-record-table-vite-cache`,
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
					"crm-record-table-use-active-node.ts"
				),
			},
			{ find: "@", replacement: desktopRoot },
		],
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5327,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-crm-record-table-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "crm-record-table-proof.html"),
		},
	},
});
