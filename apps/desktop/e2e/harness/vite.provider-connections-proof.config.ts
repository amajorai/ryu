import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const mocks = path.resolve(harnessDir, "provider-connections-mocks.tsx");

export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	optimizeDeps: {
		entries: ["provider-connections-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			{ find: "@/src/hooks/useLlmProviders.ts", replacement: mocks },
			{ find: "@/src/contexts/entitlement-context.tsx", replacement: mocks },
			{ find: "@/src/hooks/useActiveNode.ts", replacement: mocks },
			{
				find: "@/src/components/billing/OrgBillingContext.tsx",
				replacement: mocks,
			},
			{ find: "./AgentModelsSettings.tsx", replacement: mocks },
			{ find: "./CapabilityProvidersSettings.tsx", replacement: mocks },
			{ find: "@", replacement: desktopRoot },
		],
	},
	server: { host: "127.0.0.1", port: 5187, strictPort: true },
});
