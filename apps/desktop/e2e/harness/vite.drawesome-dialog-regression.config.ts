import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDirectory = path.resolve(import.meta.dirname);
const desktopDirectory = path.resolve(harnessDirectory, "../..");

export default defineConfig({
	base: "./",
	cacheDir: path.join(tmpdir(), "ryu-drawesome-dialog-regression-vite-cache"),
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root: harnessDirectory,
	resolve: { alias: { "@": desktopDirectory } },
	build: {
		outDir: `${tmpdir()}/ryu-drawesome-dialog-regression-host-build`,
		target: "esnext",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDirectory, "drawesome-dialog-regression.html"),
		},
	},
});
