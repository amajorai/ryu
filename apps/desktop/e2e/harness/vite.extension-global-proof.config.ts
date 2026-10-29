import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const desktopRoot = path.resolve(import.meta.dirname, "../..");
export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: import.meta.dirname,
	resolve: { alias: { "@": desktopRoot } },
	build: {
		reportCompressedSize: false,
		target: "esnext",
		minify: false,
		outDir: path.resolve(
			desktopRoot,
			"../../target/extension-global-proof-build"
		),
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "extension-global-proof.html"),
		},
	},
	preview: { host: "127.0.0.1", port: 5234, strictPort: true },
});
