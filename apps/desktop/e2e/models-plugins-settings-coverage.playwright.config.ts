import { defineConfig, devices, type Project } from "@playwright/test";

// Runs the existing browser proofs for the agent models, app updates, entity
// (Learning), MCP, node and resource permissions, plugin settings fields and
// provider login settings, plus this item's own coverage specs, with the host
// Chromium. Screenshots and results go under /tmp so tracked proof images stay
// untouched. RYU_MODELS_PLUGINS_ONLY (comma-separated project names) limits
// which harness servers start, since each needs its own Vite. Each project keeps
// the timeouts of the proof's own config.
const output =
	process.env.RYU_MODELS_PLUGINS_OUTPUT ??
	"/tmp/models-plugins-settings-coverage";
process.env.RYU_PROOF_EVIDENCE_DIR ??= `${output}/evidence`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

interface Proof {
	args?: string;
	env?: string;
	expectTimeout?: number;
	harness: string;
	name: string;
	page: string;
	port: number;
	spec: RegExp;
	timeout?: number;
	use?: Project["use"];
}

const proofs: Proof[] = [
	{
		name: "agent-models-settings",
		spec: /agent-models-settings-(proof|coverage)\.spec\.ts$/,
		harness: "vite.agent-models-settings-proof.config.ts",
		port: 5341,
		page: "agent-models-settings-proof.html",
		timeout: 60_000,
	},
	{
		name: "app-updates-settings",
		spec: /app-updates-settings-(proof|coverage)\.spec\.ts$/,
		harness: "vite.app-updates-settings-proof.config.ts",
		port: 5206,
		page: "app-updates-settings-proof.html",
	},
	{
		name: "app-update-transaction",
		spec: /app-update-transaction-proof\.spec\.ts$/,
		harness: "vite.app-update-transaction.config.ts",
		env: "RYU_E2E_PORT=5269",
		port: 5269,
		page: "app-update-transaction-proof.html",
		timeout: 120_000,
	},
	{
		name: "learning-settings",
		spec: /learning-settings-proof\.spec\.ts$/,
		harness: "vite.learning-settings-proof.config.ts",
		port: 5398,
		page: "learning-settings-proof.html",
	},
	{
		name: "mcp-settings",
		spec: /mcp-settings-proof\.spec\.ts$/,
		harness: "vite.mcp-settings-proof.config.ts",
		args: "--port 5237",
		port: 5237,
		page: "mcp-settings-proof.html",
		timeout: 240_000,
		expectTimeout: 30_000,
	},
	{
		name: "node-permissions-settings",
		spec: /node-permissions-settings-proof\.spec\.ts$/,
		harness: "vite.node-permissions-settings-proof.config.ts",
		port: 5270,
		page: "node-permissions-settings-proof.html",
	},
	{
		name: "plugin-settings-fields",
		spec: /plugin-settings-fields-(proof|coverage)\.spec\.ts$/,
		harness: "vite.plugin-settings-fields-proof.config.ts",
		port: 5247,
		page: "plugin-settings-fields-proof.html",
		use: { actionTimeout: 8000, navigationTimeout: 30_000 },
	},
	{
		name: "plugin-settings-manifests",
		spec: /plugin-settings-manifests-proof\.spec\.ts$/,
		harness: "vite.plugin-settings-manifests-proof.config.ts",
		port: 5359,
		page: "plugin-settings-manifests-proof.html",
		timeout: 180_000,
		expectTimeout: 15_000,
		use: { actionTimeout: 30_000, navigationTimeout: 60_000 },
	},
	{
		name: "provider-login-dialog",
		spec: /provider-login-dialog-proof\.spec\.ts$/,
		harness: "vite.provider-login-dialog-proof.config.ts",
		port: 5357,
		page: "provider-login-dialog-proof.html",
		use: { permissions: ["clipboard-read", "clipboard-write"] },
	},
];

const only = new Set(
	(process.env.RYU_MODELS_PLUGINS_ONLY ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean)
);
const selected = only.size
	? proofs.filter((proof) => only.has(proof.name))
	: proofs;

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	reporter: "list",
	outputDir: `${output}/results`,
	use: {
		...devices["Desktop Chrome"],
		launchOptions: executablePath ? { executablePath } : {},
		trace: "off",
	},
	projects: selected.map((proof) => ({
		name: proof.name,
		testMatch: proof.spec,
		timeout: proof.timeout ?? 30_000,
		expect: { timeout: proof.expectTimeout ?? 5000 },
		use: {
			...devices["Desktop Chrome"],
			baseURL: `http://127.0.0.1:${proof.port}/`,
			launchOptions: executablePath ? { executablePath } : {},
			...proof.use,
		},
	})),
	webServer: selected.map((proof) => ({
		command:
			`${proof.env ?? ""} RYU_MODELS_PLUGINS_HARNESS=${proof.harness} bunx vite --config harness/vite.models-plugins-settings-coverage.config.ts ${proof.args ?? ""}`.trim(),
		url: `http://127.0.0.1:${proof.port}/${proof.page}`,
		reuseExistingServer: false,
		timeout: 180_000,
	})),
});
