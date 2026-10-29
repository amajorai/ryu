import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import fixture from "../../../core/src/usage_history/fixtures/contract.json" with {
	type: "json",
};
import {
	proofClientCapability,
	proofProxyAuthorization,
} from "./proof-proxy-authorization.ts";
import { usageHistoryProofRoutes } from "./proof-proxy-routes.ts";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
function fixtureApi(): Plugin {
	let imported = false;
	let tracking = false;
	let imports = 0;
	const sources = [
		"codex",
		"claude-code",
		"opencode",
		"gemini",
		"pi",
		"omp",
		"openclaw",
		"amp",
		"droid",
		"cline",
		"roo-code",
		"kilo-code",
		"copilot",
		"cursor-local",
		"antigravity",
		"ryu-sessions",
	].map((id) => ({
		id,
		label: id,
		transport: "localFiles",
		available: true,
		limitations:
			"Synthetic browser interaction fixture. Retained usage metadata only.",
	}));
	return {
		name: "usage-history-layout-fixture",
		configureServer(server) {
			server.middlewares.use(
				"/api/usage/history",
				async (request, response) => {
					response.setHeader("Content-Type", "application/json");
					if (request.url?.startsWith("/account-sync")) {
						response.statusCode = 403;
						response.end(
							JSON.stringify({
								error: "usage_history_owner_required",
								message: "Only the node owner may import usage history.",
							})
						);
						return;
					}
					if (request.url?.startsWith("/tracking")) {
						if (request.method === "PUT") {
							tracking = !tracking;
						}
						response.end(JSON.stringify({ enabled: tracking }));
						return;
					}
					if (request.url?.startsWith("/import")) {
						imported = true;
						imports += 1;
						response.statusCode = 202;
						response.end(
							JSON.stringify({
								id: "fixture-import",
								state: "completed",
								report: {
									scannedFiles: 1,
									importedRecords: imports === 1 ? 1 : 0,
									updatedRecords: 0,
									duplicateRecords: imports === 1 ? 0 : 1,
									skippedFiles: 0,
									errorCount: 0,
									errors: [],
									hasMore: imports === 1,
								},
							})
						);
						return;
					}
					const summary =
						imported &&
						!request.url?.includes("scope=account") &&
						!request.url?.includes("scope=unattributed") &&
						!request.url?.includes("scope=organization")
							? fixture.summary
							: {
									...fixture.summary,
									totals: Object.fromEntries(
										Object.keys(fixture.summary.totals).map((key) => [key, 0])
									),
									records: 0,
									sessions: 0,
									daily: [],
									models: [],
									sources: [],
									estimatedCostUsd: null,
									billedCostUsd: null,
									sourceEstimatedCostUsd: null,
									reportedCostUsd: null,
									cacheSavingsUsd: null,
								};
					response.end(JSON.stringify({ summary, sources }));
				}
			);
		},
	};
}
export default defineConfig({
	plugins: [
		react(),
		...(process.env.RYU_PROOF_FIXTURE === "1"
			? [fixtureApi()]
			: [
					proofProxyAuthorization(
						proofClientCapability(),
						5187,
						usageHistoryProofRoutes
					),
				]),
	],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root: harnessDir,
	cacheDir: path.resolve(desktopRoot, "node_modules/.vite/usage-history-proof"),
	optimizeDeps: {
		entries: [path.resolve(harnessDir, "usage-history-proof.html")],
	},
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: {
			"@/src/contexts/TabsContext.tsx": path.resolve(
				harnessDir,
				"usage-history-visible-tab.ts"
			),
			"@": desktopRoot,
		},
	},
	server: {
		fs: {
			deny: [
				".env",
				".env.*",
				"**/.env",
				"**/.env.*",
				"*.{crt,pem}",
				"**/.git/**",
				"**/.tmp/**",
				"**/node-auth.token",
				"**/token",
			],
		},
		host: "127.0.0.1",
		port: 5187,
		strictPort: true,
		proxy:
			process.env.RYU_PROOF_FIXTURE === "1"
				? undefined
				: {
						"/api": {
							target: process.env.RYU_PROOF_CORE_URL ?? "http://127.0.0.1:7980",
							changeOrigin: true,
							configure(proxy) {
								proxy.on("proxyReq", (request) => {
									const token = process.env.RYU_PROOF_CORE_TOKEN;
									if (token) {
										request.setHeader("Authorization", `Bearer ${token}`);
									}
								});
							},
						},
					},
	},
});
