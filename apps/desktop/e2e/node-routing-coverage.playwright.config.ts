import { defineConfig, devices } from "@playwright/test";

// Runs the two existing NodeRoutingSettings browser proofs and the
// browser-only coverage spec against this host's Chromium without rewriting
// tracked proof images: screenshots and results go under /tmp unless the
// caller overrides the directories.
const output =
	process.env.RYU_NODE_ROUTING_COVERAGE_OUTPUT ?? "/tmp/node-routing-coverage";
process.env.RYU_OPENROUTER_ROUTING_PROOF_DIR ??= `${output}/openrouter-proof`;
process.env.RYU_NODE_ROUTING_PROOF_DIR ??= `${output}/node-routing-proof`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const managedURL = "http://127.0.0.1:5487/";
const gatewayURL = "http://127.0.0.1:5418/";

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	outputDir: `${output}/results`,
	use: {
		...devices["Desktop Chrome"],
		launchOptions: executablePath ? { executablePath } : {},
		trace: "off",
	},
	projects: [
		{
			name: "managed-openrouter-routing",
			testMatch: /managed-openrouter-routing-proof\.spec\.ts$/,
			use: { baseURL: managedURL, viewport: { width: 1440, height: 1050 } },
		},
		{
			name: "node-routing-coverage",
			testMatch: /node-routing-coverage\.spec\.ts$/,
			use: { baseURL: managedURL, viewport: { width: 1440, height: 1050 } },
		},
		{
			name: "node-routing-settings",
			testMatch: /node-routing-settings-proof\.spec\.ts$/,
			use: { baseURL: gatewayURL, viewport: { width: 1440, height: 980 } },
		},
	],
	webServer: [
		{
			command:
				"bunx vite --config harness/vite.node-routing-coverage.config.ts",
			url: `${managedURL}managed-openrouter-routing-proof.html`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
		{
			command:
				"bunx vite --config harness/vite.node-routing-settings-proof.config.ts",
			url: `${gatewayURL}node-routing-settings-proof.html`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
	],
});
