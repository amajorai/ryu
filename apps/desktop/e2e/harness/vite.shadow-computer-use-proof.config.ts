import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const desktop = path.resolve(root, "../..");

export default defineConfig({
	root,
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: [path.resolve(root, "shadow-computer-use-proof.html")],
	},
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	resolve: {
		alias: [
			{
				find: "@ryu/blocks/companion/browser-recording.ts",
				replacement: path.resolve(
					root,
					"../../../../packages/blocks/src/companion/browser-recording.ts"
				),
			},
			{ find: "@", replacement: desktop },
		],
	},
	server: { host: "127.0.0.1", port: 5228, strictPort: true },
});
