import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { panelProofDependencyAliases } from "./panel-proof-dependency-aliases.ts";

const root = import.meta.dirname;
const desktop = path.resolve(root, "../..");
const mock = path.resolve(root, "assistant-panel-proof.mock.tsx");
const fixture = path.resolve(root, "assistant-history-real-proof.tsx");
export default defineConfig({
	plugins: [
		{
			name: "assistant-settings-registry-fixture",
			enforce: "pre",
			resolveId(source) {
				if (
					source.endsWith("/useAgents.ts") ||
					source === "./useAgents.ts" ||
					source.endsWith("/useActiveNode.ts") ||
					source === "./useActiveNode.ts" ||
					source.endsWith("/entitlement-context.tsx")
				) {
					return fixture;
				}
			},
		},
		react({
			exclude: [
				/\/node_modules\//,
				/\/ryu-assistant-history-real-proof-vite\/deps\//,
			],
		}),
	],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root,
	publicDir: path.resolve(desktop, "public"),
	cacheDir: `${tmpdir()}/ryu-assistant-history-real-proof-vite`,
	optimizeDeps: {
		include: ["react-compiler-runtime"],
		entries: ["assistant-history-real-proof.html"],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			...panelProofDependencyAliases(import.meta.dirname),
			...Object.entries({
				"@/src/contexts/TabsContext.tsx": fixture,
				"@/src/hooks/useSidebarVariant.ts": mock,
				"@/src/hooks/useTitleBarClearsContent.ts": mock,
				"@/src/hooks/useSpeechPlayback.ts": mock,
				"@/src/lib/realtime/jwt.ts": mock,
				"@/src/components/clips/ClipComposerControls.tsx": mock,
				"@": desktop,
			}).map(([find, replacement]) => ({ find, replacement })),
		],
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5423,
		strictPort: true,
		hmr: false,
		watch: null,
	},
});
