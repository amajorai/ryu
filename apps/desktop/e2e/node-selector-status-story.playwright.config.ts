import { defineConfig, devices } from "@playwright/test";

const portValue = process.env.RYU_NODE_SELECTOR_E2E_PORT ?? "5214";
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
	throw new Error(
		"RYU_NODE_SELECTOR_E2E_PORT must be an integer from 1 to 65535"
	);
}

const baseURL = `http://127.0.0.1:${port}/`;

export default defineConfig({
	testDir: ".",
	testMatch: /node-selector-status-story\.spec\.ts$/,
	workers: 1,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1200, height: 900 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: "bunx vite --config vite.node-selector-status-story.config.ts",
		url: `${baseURL}node-selector-status-story.html`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
