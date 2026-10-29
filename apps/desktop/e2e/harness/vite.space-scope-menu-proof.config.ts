import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DESKTOP_ROOT = path.resolve(import.meta.dirname, "../..");
const SPACES_CONTEXT_MOCK = path.resolve(
	import.meta.dirname,
	"space-scope-menu-proof.spaces-context.ts"
);

export default defineConfig({
	plugins: [react()],
	root: import.meta.dirname,
	cacheDir: "/tmp/ryu-space-scope-menu-proof-cache",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["space-scope-menu-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{
				find: "@/src/contexts/SpacesContext.tsx",
				replacement: SPACES_CONTEXT_MOCK,
			},
			{ find: "@", replacement: DESKTOP_ROOT },
		],
	},
	build: {
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "space-scope-menu-proof.html"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5517,
		strictPort: true,
		watch: null,
		hmr: false,
	},
});
