import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDirectory = path.resolve(import.meta.dirname);
const desktopDirectory = path.resolve(harnessDirectory, "../..");

export default defineConfig({
	base: "./",
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root: harnessDirectory,
	publicDir: path.resolve(desktopDirectory, "public"),
	resolve: {
		alias: { "@": desktopDirectory },
		dedupe: ["react", "react-dom"],
	},
	build: {
		outDir: `${tmpdir()}/ryu-tuition-companion-host-build`,
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDirectory, "tuition-companion-proof.html"),
		},
	},
});
