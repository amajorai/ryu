import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const desktop = path.resolve(import.meta.dirname, "../../..");
export default defineConfig({
	root: import.meta.dirname,
	plugins: [react()],
	cacheDir: path.join(tmpdir(), "ryu-license-reader-proof-vite"),
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["index.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: { dedupe: ["react", "react-dom"], alias: { "@": desktop } },
	server: { host: "127.0.0.1", port: 33_371, strictPort: true },
});
