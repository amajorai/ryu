import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import { defineConfig } from "vite";
const harnessDir = import.meta.dirname;
export default defineConfig({
	root: harnessDir,
	plugins: [react()],
	define: { "process.env": {} },
	resolve: { alias: { "@": path.resolve(harnessDir, "../..") } },
	css: { postcss: { plugins: [tailwindcss()] } },
	server: { host: "127.0.0.1", port: 5610, strictPort: true },
	optimizeDeps: {
		entries: [path.resolve(harnessDir, "model-insight-native-http.html")],
		esbuildOptions: { target: "esnext" },
	},
});
