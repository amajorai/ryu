import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	cacheDir: `${tmpdir()}/ryu-scrollable-tabs-host-vite-cache`,
	optimizeDeps: {
		entries: ["scrollable-tabs-host-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	clearScreen: false,
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@": desktopRoot,
			react: path.resolve(desktopRoot, "node_modules/react"),
			"react-dom": path.resolve(desktopRoot, "node_modules/react-dom"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5388,
		strictPort: true,
	},
	build: {
		outDir: "/tmp/ryu-scrollable-tabs-host-proof-build",
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "scrollable-tabs-host-proof.html"),
		},
	},
});
