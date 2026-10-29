import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
const harnessDir = path.resolve(import.meta.dirname),
	desktopRoot = path.resolve(harnessDir, "../..");
export default defineConfig({
	plugins: [react()],
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	resolve: { dedupe: ["react", "react-dom"], alias: { "@": desktopRoot } },
	optimizeDeps: { entries: ["system-notifications-story.html"] },
	cacheDir: path.resolve(harnessDir, ".vite-system-notifications-story"),
	server: { host: "127.0.0.1", port: 5660, strictPort: true },
	build: {
		outDir: path.resolve(harnessDir, "dist-system-notifications-story"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "system-notifications-story.html"),
		},
	},
});
