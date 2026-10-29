import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;
export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "/tmp/ryu-web-catalog-build",
		rollupOptions: {
			input: path.join(root, "web-catalog-performance-proof.html"),
		},
	},
	root,
	cacheDir: "/tmp/ryu-web-catalog-cache",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: {
		"process.env.NEXT_PUBLIC_SERVER_URL": JSON.stringify(
			"http://127.0.0.1:5216"
		),
		"process.env.NODE_ENV": JSON.stringify("development"),
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{
				find: "@/hooks/use-marketplace-following.tsx",
				replacement: path.join(root, "universal-search-following.ts"),
			},
			{
				find: "next/link",
				replacement: path.resolve(
					root,
					"../../../web/node_modules/next/link.js"
				),
			},
			{
				find: "@ryu/env/web",
				replacement: path.join(root, "web-catalog-performance-env.ts"),
			},
			{ find: "@", replacement: path.resolve(root, "../../../web/src") },
		],
	},
	optimizeDeps: {
		entries: ["web-catalog-performance-proof.html"],
		include: ["lucide-react"],

		esbuildOptions: { target: "esnext" },
	},
	server: {
		host: "127.0.0.1",
		port: 5216,
		strictPort: true,
		watch: null,
		hmr: false,
	},
});
