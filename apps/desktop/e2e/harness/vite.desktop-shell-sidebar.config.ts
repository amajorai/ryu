import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;
export default defineConfig({
	root,
	cacheDir: `${tmpdir()}/ryu-desktop-shell-sidebar-vite`,
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{
				find: "@/src/pages/PluginCompanionPage.tsx",
				replacement: path.resolve(
					root,
					"desktop-shell-sidebar-companion.fixture.tsx"
				),
			},
			{ find: "@", replacement: path.resolve(root, "../..") },
		],
	},
	optimizeDeps: {
		entries: ["desktop-shell-sidebar.html"],
		esbuildOptions: { target: "esnext" },
	},
	publicDir: path.resolve(root, "../../public"),
	server: { host: "127.0.0.1", port: 5493, strictPort: true },
});
