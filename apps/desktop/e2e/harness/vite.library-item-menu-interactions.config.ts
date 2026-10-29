import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	resolve: {
		alias: [
			{
				find: "@/src/contexts/entitlement-context.tsx",
				replacement: path.resolve(
					harnessDir,
					"app-sidebar-entitlement.mock.tsx"
				),
			},
			{ find: "@", replacement: desktopRoot },
		],
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5198,
		strictPort: true,
	},
	build: {
		outDir: "/private/tmp/ryu-library-item-menu-interactions-build",
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "library-item-menu-interactions.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
