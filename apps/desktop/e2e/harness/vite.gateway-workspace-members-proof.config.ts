import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const fixture = path.resolve(
	harnessDir,
	"gateway-workspace-members-proof.mock.tsx"
);
export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-gateway-workspace-members-vite-cache`,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["gateway-workspace-members-proof.html"],

		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{ find: "@/lib/auth-client.ts", replacement: fixture },
			{ find: "@/lib/tauri-bridge.ts", replacement: fixture },
			{ find: "@/src/components/StepUpDialog.tsx", replacement: fixture },
			{ find: "@/src/hooks/useActiveNode.ts", replacement: fixture },
			{ find: "@", replacement: desktopRoot },
		],
	},
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5298, strictPort: true },
});
