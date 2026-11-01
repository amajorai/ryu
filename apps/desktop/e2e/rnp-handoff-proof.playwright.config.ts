import { defineConfig, devices } from "@playwright/test";

const proofUrl = "http://127.0.0.1:5197/";

export default defineConfig({
	testDir: ".",
	testMatch: /rnp-handoff-proof\.spec\.ts/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: proofUrl,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		// Preview serves the built harness, so build it first: a fresh checkout has
		// no dist-rnp-handoff and the preview server never answered.
		command:
			"bunx vite build --config harness/vite.rnp-handoff-proof.config.ts && bunx vite preview --config harness/vite.rnp-handoff-proof.config.ts --port 5197 --strictPort",
		url: `${proofUrl}rnp-handoff-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
