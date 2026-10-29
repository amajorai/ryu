import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(
	import.meta.dirname,
	"agent-budget-panel-sweep"
);
const desktopRoot = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	resolve: { alias: { "@": desktopRoot } },
	server: {
		hmr: false,
		host: "127.0.0.1",
		port: 5287,
		strictPort: true,
	},
	build: {
		outDir: "/private/tmp/ryu-agent-budget-panel-sweep-vite-dist",
		target: "chrome105",
		emptyOutDir: true,
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
