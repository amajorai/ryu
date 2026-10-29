import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const desktop = path.resolve(root, "../..");

export default defineConfig({
	root,
	optimizeDeps: {
		entries: [path.resolve(root, "clips-quick-attach-destination-proof.html")],

		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	resolve: {
		alias: [{ find: "@", replacement: desktop }],
	},
	server: { host: "127.0.0.1", port: 5237, strictPort: true },
});
