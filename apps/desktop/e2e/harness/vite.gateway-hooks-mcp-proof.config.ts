import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const activeNodeMock = path.resolve(
	harnessDir,
	"gateway-hooks-mcp-proof.active-node.ts"
);

export default defineConfig({
	plugins: [react()],
	base: "./",
	cacheDir: `${tmpdir()}/ryu-gateway-hooks-mcp-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["gateway-hooks-mcp-proof.html"],
		force: false,

		esbuildOptions: { target: "esnext" },
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{ find: "@/src/hooks/useActiveNode.ts", replacement: activeNodeMock },
			{ find: "@", replacement: desktopRoot },
			{
				find: "react",
				replacement: path.resolve(desktopRoot, "node_modules/react"),
			},
			{
				find: "react-dom",
				replacement: path.resolve(desktopRoot, "node_modules/react-dom"),
			},
		],
	},
	server: {
		hmr: false,
		host: "127.0.0.1",
		port: 5259,
		strictPort: true,
	},
});
