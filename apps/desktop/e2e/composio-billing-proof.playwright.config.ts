import { tmpdir } from "node:os";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /composio-billing-proof\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	reporter: "list",
	// Run output (screenshots, traces) stays outside the repository so a rerun
	// never rewrites the committed proof images under docs/proof/.
	outputDir: `${tmpdir()}/ryu-composio-billing-playwright-results`,
	use: {
		baseURL: "http://127.0.0.1:5273",
		viewport: { width: 1100, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: "bunx vite --config harness/vite.composio-billing-proof.config.ts",
		url: "http://127.0.0.1:5273/composio-billing-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
