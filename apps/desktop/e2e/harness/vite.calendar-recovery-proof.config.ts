import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const nodeFixture = path.resolve(harnessDir, "calendar-recovery-proof-node.ts");
const hookFixture = path.resolve(
	harnessDir,
	"calendar-automation-proof-hooks.tsx"
);

export default defineConfig({
	base: "./",
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	define: { "process.env": {} },
	resolve: {
		alias: [
			{ find: /^\.\/useActiveNode\.ts$/, replacement: nodeFixture },
			{ find: "@/src/hooks/useActiveNode.ts", replacement: nodeFixture },
			{ find: "@/src/hooks/useAgents.ts", replacement: hookFixture },
			{
				find: "@/src/contexts/ChatHistoryContext.tsx",
				replacement: hookFixture,
			},
			{ find: "@", replacement: desktopRoot },
		],
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5392,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-calendar-recovery-proof"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "calendar-recovery-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
