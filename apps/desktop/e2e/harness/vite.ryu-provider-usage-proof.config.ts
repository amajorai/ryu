import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type ViteDevServer } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

const usageSnapshots: Record<string, object> = {
	"acp:claude": {
		agent_id: "acp:claude",
		available: true,
		engine: "claude",
		extra_usage_usd: null,
		meters: [],
		plan: "Max 20x",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Session",
				model: null,
				resets_at: "2026-08-17T18:00:00Z",
				used_percent: 28,
				window_seconds: 18_000,
			},
			{
				label: "Weekly",
				model: null,
				resets_at: "2026-08-24T00:00:00Z",
				used_percent: 62,
				window_seconds: 604_800,
			},
		],
	},
	"claude-pro-max": {
		agent_id: "claude-pro-max",
		available: true,
		engine: "claude",
		extra_usage_usd: null,
		meters: [],
		plan: "Max 20x",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Session",
				model: null,
				resets_at: "2026-08-17T18:00:00Z",
				used_percent: 34,
				window_seconds: 18_000,
			},
			{
				label: "Weekly",
				model: null,
				resets_at: "2026-08-24T00:00:00Z",
				used_percent: 58,
				window_seconds: 604_800,
			},
		],
	},
	"openai-codex": {
		agent_id: "openai-codex",
		available: true,
		engine: "codex",
		extra_usage_usd: null,
		meters: [
			{
				expires_at: ["2026-08-18T18:00:00Z"],
				label: "Rate limit resets",
				resets_at: "2026-08-18T18:00:00Z",
				values: [
					{ kind: "count", number: 3, unit: "available" },
					{ kind: "count", number: 10, unit: "cap" },
				],
			},
		],
		plan: "Plus",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Session",
				model: null,
				resets_at: "2026-08-17T18:00:00Z",
				used_percent: 41,
				window_seconds: 18_000,
			},
			{
				label: "Weekly",
				model: null,
				resets_at: "2026-08-24T00:00:00Z",
				used_percent: 73,
				window_seconds: 604_800,
			},
		],
	},
	"github-copilot": {
		agent_id: "github-copilot",
		available: true,
		engine: "copilot",
		extra_usage_usd: null,
		meters: [],
		plan: "Pro",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Credits",
				model: null,
				resets_at: "2026-09-01T00:00:00Z",
				used_percent: 19,
				window_seconds: 2_592_000,
			},
		],
	},
};

function usageProofApi(server: ViteDevServer) {
	server.middlewares.use("/api/agents", (request, response, next) => {
		const match = request.url?.match(/^\/([^/]+)\/usage(?:\?|$)/);
		const id = match ? decodeURIComponent(match[1] ?? "") : "";
		const snapshot = usageSnapshots[id];
		if (!snapshot) {
			next();
			return;
		}
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify(snapshot));
	});
}

export default defineConfig({
	plugins: [
		react(),
		{
			name: "ryu-provider-usage-proof-api",
			configureServer: usageProofApi,
		},
	],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	// The real provider picker imports a small Next navigation adapter. The proof
	// runs under Vite, so provide the compile-time env object that adapter expects.
	define: {
		"process.env": {},
	},
	root: harnessDir,
	clearScreen: false,
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		port: 5178,
		strictPort: true,
	},
});
