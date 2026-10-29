import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.resolve(import.meta.dirname, "kill-switch");
const desktopRoot = path.resolve(root, "../../..");
const port = Number(process.env.RYU_KILL_SWITCH_PROOF_PORT ?? "5264");
export default defineConfig({
	root,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	optimizeDeps: {
		entries: ["kill-switch-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			{
				find: "@ryu/blocks/companion/browser-recording.ts",
				replacement: path.resolve(
					desktopRoot,
					"../../packages/blocks/src/companion/browser-recording.ts"
				),
			},
			{ find: "@", replacement: desktopRoot },
		],
	},
	server: { host: "127.0.0.1", port, strictPort: true },
});
