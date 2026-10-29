import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harness = import.meta.dirname;
const desktop = path.resolve(harness, "../..");
const web = path.resolve(desktop, "../web");
const fixtureOrigin = "http://localhost:5197";
const virtualPrefix = "\0creator-profile-leaf:";
const mocks = {
	auth: `export const BACKEND_URL = ${JSON.stringify(fixtureOrigin)}; export const FRONTEND_URL = ${JSON.stringify(fixtureOrigin)}; export const TOKEN_KEY = "creator-proof-token"; export const getActiveUserId = () => "fixture-user"; export const authClient = { useSession: () => ({data: {user:{id:"fixture-user"},session:{activeOrganizationId:"org-a"}}}), useActiveOrganization: () => ({data:{id:"org-a"}}) };`,
	step: "const guard = async (_scope, action) => action(); export const useStepUp = () => ({guard, dialog:null});",
	hooks:
		"export const useMarketplaceMembershipReport = () => ({}); export const useMyLicenses = () => ({}); export const useSellerReports = () => ({}); export const useSellerStatus = () => ({});",
	bridge: "export const openExternal = async () => undefined;",
	client: `export const buyerTokenHeader = () => ({}); export const request = async () => {throw new Error("Unplanned Core request");};`,
	follow: "export const FollowOrganizationButton = () => null;",
	env: `export const env = {NEXT_PUBLIC_SERVER_URL:${JSON.stringify(fixtureOrigin)}};`,
};
export default defineConfig({
	root: harness,
	clearScreen: false,
	optimizeDeps: {
		entries: [path.resolve(harness, "creator-profile-host-proof.html")],
		exclude: ["@ryu/env", "@ryu/env/web"],

		esbuildOptions: { target: "esnext" },
	},
	plugins: [
		{
			name: "creator-proof-environment-leaves",
			enforce: "pre",
			resolveId(source, importer) {
				const modulePath = source.split("?")[0];
				if (
					modulePath === "@ryu/env/web" ||
					modulePath === "@ryu/env/web.ts" ||
					modulePath.endsWith("/packages/env/src/web.ts") ||
					modulePath.endsWith("/@ryu/env/src/web.ts")
				) {
					return `${virtualPrefix}env`;
				}
				if (source.includes("auth-client.ts")) {
					return `${virtualPrefix}auth`;
				}
				if (
					source.includes("StepUpDialog") ||
					source.includes("step-up-dialog")
				) {
					return `${virtualPrefix}step`;
				}
				if (
					source.includes("hooks/use-marketplace") ||
					/hooks\/use(?:MyLicenses|SellerReports|SellerStatus|MarketplaceMembershipReport)/.test(
						source
					)
				) {
					return `${virtualPrefix}hooks`;
				}
				if (source.includes("tauri-bridge")) {
					return `${virtualPrefix}bridge`;
				}
				if (source.includes("follow-organization-button")) {
					return `${virtualPrefix}follow`;
				}
				if (
					modulePath === "@/src/lib/api/client.ts" ||
					modulePath.endsWith("/apps/desktop/src/lib/api/client.ts")
				) {
					return `${virtualPrefix}client`;
				}
				if (source.startsWith("@/")) {
					return path.resolve(
						importer?.includes("/apps/web/") ? `${web}/src` : desktop,
						source.slice(2)
					);
				}
			},
			load(id) {
				if (id.startsWith(virtualPrefix)) {
					return Object.entries(mocks).find(
						([key]) => key === id.slice(virtualPrefix.length)
					)?.[1];
				}
			},
		},
		react(),
	],
	css: { postcss: { plugins: [tailwindcss()] } },
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			react: path.resolve(desktop, "node_modules/react"),
			"react-dom": path.resolve(desktop, "node_modules/react-dom"),
		},
	},
	server: { port: 5197, strictPort: true },
});
