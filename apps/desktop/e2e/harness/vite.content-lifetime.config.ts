import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
	plugins: [react()],
	root: import.meta.dirname,
	cacheDir: "/tmp/ryu-content-lifetime-cache",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["content-lifetime-proof.html"],
		include: ["lucide-react"],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"wxt/browser": path.resolve(
				import.meta.dirname,
				"content-lifetime-browser.ts"
			),
			"wxt/utils/content-script-context": path.resolve(
				import.meta.dirname,
				"../../../extension/node_modules/wxt/dist/utils/content-script-context.mjs"
			),
			"@extension/lib/page-extract.ts": path.resolve(
				import.meta.dirname,
				"content-lifetime-extract.ts"
			),
			"@extension/lib/ai-sites/registry.ts": path.resolve(
				import.meta.dirname,
				"content-lifetime-adapter.ts"
			),
			"@extension/lib/copilot/mount.tsx": path.resolve(
				import.meta.dirname,
				"content-lifetime-copilot.ts"
			),
			"@extension": path.resolve(import.meta.dirname, "../../../extension"),
			"@": path.resolve(import.meta.dirname, "../.."),
		},
	},
	build: {
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "content-lifetime-proof.html"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5221,
		strictPort: true,
		watch: null,
		hmr: false,
	},
});
