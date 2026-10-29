import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-library-source-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["library-source-proof.html"],
		force: true,
		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			...[
				"@/src/hooks/useActiveNode.ts",
				"@/src/contexts/TabsContext.tsx",
				"@/lib/auth-client.ts",
				"@/src/lib/realtime/jwt.ts",
			].map((find) => ({
				find,
				replacement: path.resolve(harnessDir, "library-source-proof.mock.ts"),
			})),
			{ find: "@", replacement: desktopRoot },
		],
	},
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5437, strictPort: true },
});
