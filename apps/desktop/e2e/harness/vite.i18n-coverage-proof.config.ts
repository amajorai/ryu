import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDirectory = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDirectory, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: { "process.env": {} },
	root: harnessDirectory,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	optimizeDeps: {
		entries: ["i18n-coverage-proof.html"],
		exclude: ["@ryu/blocks", "@ryu/i18n", "@ryu/ui"],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@": desktopRoot,
			react: path.resolve(desktopRoot, "node_modules/react"),
			"react-dom": path.resolve(desktopRoot, "node_modules/react-dom"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_I18N_E2E_PORT ?? "5224"),
		strictPort: true,
		watch: { ignored: ["**/dist/**", "**/.next/**"] },
	},
	build: {
		rollupOptions: {
			input: path.resolve(harnessDirectory, "i18n-coverage-proof.html"),
		},
	},
});
