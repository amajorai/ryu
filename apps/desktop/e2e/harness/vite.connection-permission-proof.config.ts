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
	define: {
		"process.env": {},
	},
	optimizeDeps: {
		entries: [path.resolve(harnessDir, "connection-permission-proof.html")],
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5193,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-connection-permission-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "connection-permission-proof.html"),
		},
	},
});
