import { defineConfig, devices } from "@playwright/test";

const proofUrl = "http://127.0.0.1:5286/";

export default defineConfig({
	outputDir: "/tmp/ryu-quests-settings-proof-results",
	testDir: ".",
	testMatch: /quests-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	timeout: 45_000,
	use: {
		baseURL: proofUrl,
		...devices["Desktop Chrome"],
		viewport: { width: 1360, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: "bunx vite --config harness/vite.quests-settings-proof.config.ts",
		url: `${proofUrl}quests-settings-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
