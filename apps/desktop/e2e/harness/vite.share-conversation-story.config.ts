import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "/",
	cacheDir: "/tmp/ryu-share-conversation-vite-cache",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	optimizeDeps: {
		entries: ["share-conversation-story.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: { "@": desktopRoot },
	},
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5388, strictPort: true },
});
