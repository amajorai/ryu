import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices, type Project } from "@playwright/test";

// Runs the existing Gateway budgets, agent import/export, shell node selector,
// startup-performance and plugin-shortcut browser proofs with an explicit
// Chromium binary and caller-owned output, cache and evidence directories.
// Each proof keeps its own harness; harness/vite.gateway-specs-b-coverage
// serves it on its own port so this run never collides with another proof
// that shares the harness's fixed port. RYU_GATEWAY_SPECS_B_ONLY
// (comma-separated project names) limits which harness servers start. Each
// project keeps the timeout and viewport of the proof's own config.
const output =
	process.env.RYU_GATEWAY_SPECS_B_OUTPUT ?? "/tmp/gateway-specs-b-pw";
// The proofs refresh committed evidence screenshots by default; a coverage run
// writes them to scratch so the tracked proof ledger stays untouched.
process.env.RYU_PROOF_EVIDENCE_DIR ??= `${output}/evidence`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const viteCache =
	process.env.RYU_GATEWAY_SPECS_B_VITE_CACHE ?? `${output}/vite`;
const only = process.env.RYU_GATEWAY_SPECS_B_ONLY;
const selected = (name: string) => !only || only.split(",").includes(name);

interface Proof {
	host?: string;
	name: string;
	page: string;
	port: number;
	spec: RegExp;
	timeout?: number;
	use?: Project["use"];
}

const proofs: Proof[] = [
	{
		name: "budgets",
		spec: /gateway-budgets-settings-proof\.spec\.ts$/,
		port: 47_261,
		page: "gateway-budgets-settings-proof.html",
	},
	{
		name: "agent-sync",
		spec: /agent-sync-proof\.spec\.ts$/,
		port: 47_266,
		host: "localhost",
		page: "agent-sync-proof.html",
		use: { viewport: { height: 1000, width: 1600 } },
	},
	{
		name: "node-selector",
		spec: /node-selector-proof\.spec\.ts$/,
		port: 47_270,
		page: "node-selector-proof.html",
	},
	{
		name: "startup-performance",
		spec: /startup-performance-proof\.spec\.ts$/,
		port: 47_271,
		page: "startup-performance-proof.html",
		use: { viewport: { height: 900, width: 1440 } },
	},
].filter((proof) => selected(proof.name));

// The plugin-shortcut proof pins its host (33367) and page (33368) origins in
// the spec's own origin guard, so it keeps its harness ports. It is served from
// a bundle that the caller builds first (harness/vite.gateway-specs-b-coverage
// with RYU_GATEWAY_SPECS_B_HARNESS=plugin-shortcuts-static), exactly as
// plugin-shortcuts-static.playwright.config.ts does, with that config's 60 s
// budget: the dev-server route re-fetches thousands of unbundled modules on
// every navigation and needs a 900 s budget on a loaded host.
const pluginShortcutsDist = process.env.RYU_PLUGIN_SHORTCUTS_DIST;
const pluginShortcuts = selected("plugin-shortcuts");
if (
	pluginShortcuts &&
	!(
		pluginShortcutsDist &&
		path.isAbsolute(pluginShortcutsDist) &&
		existsSync(path.join(pluginShortcutsDist, "index.html"))
	)
) {
	throw new Error(
		"plugin-shortcuts needs a built harness in an absolute RYU_PLUGIN_SHORTCUTS_DIST"
	);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	reporter: "list",
	outputDir: `${output}/results`,
	projects: [
		...proofs.map((proof) => ({
			name: proof.name,
			testMatch: proof.spec,
			...(proof.timeout ? { timeout: proof.timeout } : {}),
			use: {
				...devices["Desktop Chrome"],
				...proof.use,
				baseURL: `http://${proof.host ?? "127.0.0.1"}:${proof.port}/`,
				launchOptions: executablePath ? { executablePath } : {},
				trace: "off" as const,
			},
		})),
		...(pluginShortcuts
			? [
					{
						name: "plugin-shortcuts",
						testMatch: "plugin-shortcuts-proof.spec.ts",
						timeout: 60_000,
						use: {
							baseURL: "http://127.0.0.1:33368",
							headless: true,
							launchOptions: executablePath ? { executablePath } : {},
							trace: "off" as const,
						},
					},
				]
			: []),
	],
	webServer: [
		...proofs.map((proof) => ({
			command:
				"bunx vite --config harness/vite.gateway-specs-b-coverage.config.ts",
			env: {
				RYU_GATEWAY_SPECS_B_HARNESS: proof.name,
				RYU_GATEWAY_SPECS_B_PORT: String(proof.port),
				RYU_GATEWAY_SPECS_B_VITE_CACHE: viteCache,
			},
			url: `http://127.0.0.1:${proof.port}/${proof.page}`,
			reuseExistingServer: false,
			timeout: 180_000,
		})),
		...(pluginShortcuts && pluginShortcutsDist
			? [
					{
						command: "bun harness/plugin-shortcuts-proof/host.ts",
						url: "http://127.0.0.1:33367/health",
						reuseExistingServer: false,
						timeout: 30_000,
					},
					{
						command: `python3 -m http.server 33368 --bind 127.0.0.1 --directory ${quote(pluginShortcutsDist)}`,
						url: "http://127.0.0.1:33368/index.html",
						reuseExistingServer: false,
						timeout: 30_000,
					},
				]
			: []),
	],
});
