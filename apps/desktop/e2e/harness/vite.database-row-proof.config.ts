import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const bridge = path.resolve(root, "database-row-proof.bridge.ts");
export default defineConfig({
	root,
	cacheDir: `${tmpdir()}/ryu-database-row-vite-cache`,
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["database-row-proof.html"],
	},
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			...[
				"@/src/contexts/SpacesContext.tsx",
				"@/src/contexts/TabsContext.tsx",
				"@/src/hooks/useActiveNode.ts",
				"@/src/lib/realtime/use-database-collab.ts",
			].map((find) => ({ find, replacement: bridge })),
			{ find: "@", replacement: path.resolve(root, "../..") },
		],
	},
	server: { host: "127.0.0.1", port: 5335, strictPort: true },
});
