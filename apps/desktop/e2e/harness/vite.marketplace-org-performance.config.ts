import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;
export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "/tmp/ryu-marketplace-org-build",
		rollupOptions: {
			input: path.join(root, "marketplace-org-performance-proof.html"),
		},
	},
	root,
	cacheDir: "/tmp/ryu-marketplace-org-cache",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: {
		"process.env.NEXT_PUBLIC_SERVER_URL": JSON.stringify(
			"http://127.0.0.1:5217"
		),
		"process.env.NODE_ENV": JSON.stringify("development"),
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{
				find: "@/lib/auth-client.ts",
				replacement: path.join(root, "marketplace-auth-state.ts"),
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
				replacement: path.join(root, "marketplace-org-performance-env.ts"),
			},
			{ find: "@", replacement: path.resolve(root, "../../../web/src") },
		],
	},
	optimizeDeps: {
		entries: ["marketplace-org-performance-proof.html"],
		include: ["lucide-react"],

		esbuildOptions: { target: "esnext" },
	},
	server: {
		host: "127.0.0.1",
		port: 5217,
		strictPort: true,
		watch: null,
		hmr: false,
	},
});
