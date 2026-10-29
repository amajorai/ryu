import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const seams = path.resolve(harnessDir, "provider-connections-live-seams.tsx");
const profileDir = process.env.RYU_LIVE_QA_DIR;
if (!profileDir) {
	throw new Error("Set RYU_LIVE_QA_DIR to the isolated Core profile directory");
}
// Server-side only: never inline the private node token into the browser bundle.
const token = readFileSync(
	path.join(profileDir, "node-auth.token"),
	"utf8"
).trim();
const proxy = {
	"/api": {
		target: process.env.RYU_LIVE_QA_CORE_URL ?? "http://127.0.0.1:8980",
		headers: { Authorization: `Bearer ${token}` },
	},
};
export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	optimizeDeps: { entries: ["provider-connections-proof.html"] },
	build: {
		outDir: path.resolve(desktopRoot, "../../.tmp/oauth-ui-resume-build"),
		rollupOptions: {
			input: path.join(harnessDir, "provider-connections-proof.html"),
		},
	},
	preview: { host: "127.0.0.1", port: 5186, strictPort: true, proxy },
	resolve: {
		alias: [
			{ find: "@/src/hooks/useActiveNode.ts", replacement: seams },
			{ find: "./useActiveNode.ts", replacement: seams },
			{ find: "@/src/contexts/entitlement-context.tsx", replacement: seams },
			{
				find: "@/src/components/billing/OrgBillingContext.tsx",
				replacement: seams,
			},
			{ find: "./AgentModelsSettings.tsx", replacement: seams },
			{ find: "./CapabilityProvidersSettings.tsx", replacement: seams },
			{ find: "@", replacement: desktopRoot },
		],
	},
	server: {
		host: "127.0.0.1",
		port: 5186,
		strictPort: true,
		proxy,
	},
});
