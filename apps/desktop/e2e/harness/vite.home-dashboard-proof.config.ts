import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const proofDir = path.resolve(harnessDir, "home-dashboard-proof");

export default defineConfig({
	plugins: [react()],
	base: "./",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root: harnessDir,
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite-home-dashboard-proof"
	),
	publicDir: path.resolve(desktopRoot, "public"),
	optimizeDeps: {
		entries: ["home-dashboard-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: {
			"@ryuhq/core-client/realtime.ts": path.resolve(proofDir, "realtime.ts"),
			"@/src/components/dashboard/DashboardCanvas.tsx": path.resolve(
				proofDir,
				"dashboard-canvas.tsx"
			),
			"@/src/contexts/TitleBarContext.tsx": path.resolve(
				proofDir,
				"titlebar.tsx"
			),
			"@/src/hooks/useActiveNode.ts": path.resolve(proofDir, "active-node.ts"),
			"@/src/hooks/useAssistantPageContext.ts": path.resolve(
				proofDir,
				"page-context-hook.ts"
			),
			"@/src/lib/realtime/jwt.ts": path.resolve(proofDir, "realtime-jwt.ts"),
			"@": desktopRoot,
		},
	},
	server: { host: "127.0.0.1", port: 5205, strictPort: true },
});
