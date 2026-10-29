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
	resolve: { alias: { "@": desktopDirectory } },
	build: {
		outDir: `${tmpdir()}/ryu-mail-companion-host-build`,
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDirectory, "mail-companion-proof.html"),
		},
	},
});
