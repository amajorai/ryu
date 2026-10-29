import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDirectory = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDirectory, "../..");

export default defineConfig({
	plugins: [react()],
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
		entries: ["login-i18n-proof.html"],
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
		port: Number(process.env.RYU_LOGIN_I18N_E2E_PORT ?? "5232"),
		strictPort: true,
		watch: { ignored: ["**/dist/**", "**/.next/**"] },
	},
	build: {
		rollupOptions: {
			input: path.resolve(harnessDirectory, "login-i18n-proof.html"),
		},
	},
});
