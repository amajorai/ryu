import { defineConfig, devices } from "@playwright/test";

// Runs the four existing Connections / Integrations / Providers / Composio
// billing browser proofs against their unchanged harnesses with an explicit
// Chromium binary and caller-owned output directories. Each harness keeps its
// own Vite config and port, and screenshots land in this run's output folder.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const output =
	process.env.RYU_CONNECTIONS_PROVIDERS_PW_OUTPUT ??
	"/tmp/connections-providers-pw";

const harnesses = [
	{
		name: "connections-tab",
		port: 5307,
		ready: "connections-tab-proof.html",
		spec: /connections-tab-proof\.spec\.ts$/,
		vite: "harness/vite.connections-tab-proof.config.ts",
		viewport: { width: 1280, height: 720 },
	},
	{
		name: "gateway-integrations",
		port: 5256,
		ready: "gateway-integrations-settings-proof.html",
		spec: /gateway-integrations-settings-proof\.spec\.ts$/,
		vite: "harness/vite.gateway-integrations-settings-proof.config.ts",
		viewport: { width: 1280, height: 720 },
	},
	{
		name: "gateway-ai-providers",
		port: 5297,
		ready: "gateway-ai-providers-proof.html",
		spec: /gateway-ai-providers-proof\.spec\.ts$/,
		vite: "harness/vite.gateway-ai-providers-proof.config.ts",
		viewport: { width: 1280, height: 720 },
	},
	{
		name: "composio-billing",
		port: 5273,
		ready: "composio-billing-proof.html",
		spec: /composio-billing-proof\.spec\.ts$/,
		vite: "harness/vite.composio-billing-proof.config.ts",
		viewport: { width: 1100, height: 1000 },
	},
] as const;

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	timeout: 90_000,
	outputDir: `${output}/results`,
	projects: harnesses.map((harness) => ({
		name: harness.name,
		testMatch: harness.spec,
		use: {
			...devices["Desktop Chrome"],
			baseURL: `http://127.0.0.1:${harness.port}/`,
			launchOptions: executablePath ? { executablePath } : {},
			trace: "off",
			viewport: harness.viewport,
		},
	})),
	webServer: harnesses.map((harness) => ({
		command: `bunx vite --config ${harness.vite}`,
		url: `http://127.0.0.1:${harness.port}/${harness.ready}`,
		reuseExistingServer: false,
		timeout: 120_000,
	})),
});
