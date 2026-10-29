import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fixture = path.resolve(
	import.meta.dirname,
	"bot-managed-entry-proof.fixture.tsx"
);
export default defineConfig({
	root: import.meta.dirname,
	clearScreen: false,
	cacheDir: `${tmpdir()}/ryu-bot-managed-entry-proof-vite`,
	plugins: [
		react({
			exclude: [
				/\/node_modules\//,
				/\/ryu-bot-managed-entry-proof-vite\/deps\//,
			],
		}),
	],
	css: { postcss: { plugins: [tailwindcss()] } },
	optimizeDeps: {
		entries: ["bot-managed-entry-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			...[
				"@/src/store/useNodeStore.ts",
				"@/src/hooks/useCreditsWallet.ts",
				"@/src/components/layout/Layout.tsx",
				"@/lib/auth-client.ts",
				"@/src/lib/realtime/jwt.ts",
				"@/lib/tauri-bridge.ts",
			].map((find) => ({ find, replacement: fixture })),
			{ find: "@", replacement: path.resolve(import.meta.dirname, "../..") },
		],
		dedupe: ["react", "react-dom"],
	},
	server: { host: "127.0.0.1", port: 5494, strictPort: true },
});
