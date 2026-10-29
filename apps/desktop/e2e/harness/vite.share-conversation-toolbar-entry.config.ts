import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
	root,
	optimizeDeps: {
		entries: ["share-conversation-toolbar-entry.html"],
		include: ["@tauri-apps/api/window"],
		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	resolve: {
		alias: [
			{ find: "@", replacement: path.resolve(root, "../..") },
			{
				find: /^@hugeicons\/core-free-icons$/,
				replacement: path.join(
					path.dirname(
						fileURLToPath(
							import.meta.resolve("@hugeicons/core-free-icons/package.json")
						)
					),
					"dist/esm/index.js"
				),
			},
		],
		dedupe: ["react", "react-dom"],
	},
	define: { "process.env": {} },
	server: {
		host: "127.0.0.1",
		port: 5198,
		strictPort: true,
		hmr: false,
		watch: { ignored: ["**/*"] },
	},
});
