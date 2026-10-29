import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
export default defineConfig({
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	base: "./",
	clearScreen: false,
	resolve: { alias: { "@": path.resolve(harnessDir, "../..") } },
	server: { host: "127.0.0.1", port: 5197, strictPort: true },
	build: {
		outDir: "/tmp/ryu-device-permissions-proof",
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "device-permissions-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
