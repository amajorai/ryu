import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const desktop = path.resolve(root, "../..");
const mock = path.resolve(root, "declarative-view-proof.mock.ts");
export default defineConfig({
	root,
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	optimizeDeps: {
		entries: ["declarative-view-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			...[
				"@/src/hooks/useActiveNode.ts",
				"@/src/hooks/usePluginContributions.ts",
				"@/src/contexts/TabsContext.tsx",
				"@/lib/auth-client.ts",
				"@/src/lib/dev-metrics.ts",
			].map((find) => ({ find, replacement: mock })),
			{ find: "@", replacement: desktop },
			{
				find: "react",
				replacement: path.resolve(desktop, "node_modules/react"),
			},
			{
				find: "react-dom",
				replacement: path.resolve(desktop, "node_modules/react-dom"),
			},
		],
	},
	server: { host: "127.0.0.1", port: 58_441, strictPort: true },
});
