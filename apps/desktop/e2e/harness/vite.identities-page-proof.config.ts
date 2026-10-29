import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const buildDir = path.resolve(
	harnessDir,
	"../../../../tmp/ryu-identities-page-proof"
);

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	base: "./",
	clearScreen: false,
	publicDir: path.resolve(harnessDir, "../../public"),
	resolve: {
		alias: [
			{
				find: "@/src/hooks/useActiveNode.ts",
				replacement: path.resolve(harnessDir, "identities-active-node.ts"),
			},
			{ find: "@", replacement: path.resolve(harnessDir, "../..") },
		],
	},
	build: {
		outDir: buildDir,
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "identities-page-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
