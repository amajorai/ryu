import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { panelProofDependencyAliases } from "./panel-proof-dependency-aliases.ts";

const root = import.meta.dirname;
const desktop = path.resolve(root, "../..");
const mock = path.resolve(root, "assistant-panel-proof.mock.tsx");
export default defineConfig({
	plugins: [
		react({
			exclude: [/\/node_modules\//, /\/ryu-assistant-panel-proof-vite\/deps\//],
		}),
	],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root,
	cacheDir: `${tmpdir()}/ryu-assistant-panel-proof-vite`,
	optimizeDeps: {
		include: ["react-compiler-runtime"],
		entries: ["assistant-panel-proof.html"],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			...panelProofDependencyAliases(import.meta.dirname),
			...Object.entries({
				"@/src/contexts/ChatHistoryContext.tsx": mock,
				"@/src/contexts/TabsContext.tsx": mock,
				"@/src/hooks/useActiveNode.ts": mock,
				"@/src/hooks/useBuilderRuntime.ts": mock,
				"@/src/hooks/useAgents.ts": mock,
				"@/src/hooks/useInterfaceLevel.ts": mock,
				"@/src/hooks/useSidebarVariant.ts": mock,
				"@/src/hooks/useTitleBarClearsContent.ts": mock,
				"@/src/hooks/useSpeechPlayback.ts": mock,
				"@/src/lib/realtime/jwt.ts": mock,
				"@/src/components/clips/ClipComposerControls.tsx": mock,
				"./useComposerSlot.tsx": mock,
				"@": desktop,
			}).map(([find, replacement]) => ({ find, replacement })),
		],
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5417,
		strictPort: true,
		hmr: false,
		watch: null,
	},
});
