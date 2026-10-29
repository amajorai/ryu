import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.resolve(import.meta.dirname);
export default defineConfig({
	root,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: {
		"process.env": JSON.stringify({
			NEXT_PUBLIC_SERVER_URL: "http://127.0.0.1:5199",
		}),
	},
	plugins: [react()],
	resolve: { alias: { "@": path.resolve(root, "../../../web/src") } },
	optimizeDeps: {
		entries: ["watch-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: {
		host: "127.0.0.1",
		port: 5199,
		strictPort: true,
		proxy: {
			"/api/watch": "http://127.0.0.1:5198",
			"/api/user/notifications": "http://127.0.0.1:5198",
		},
	},
});
