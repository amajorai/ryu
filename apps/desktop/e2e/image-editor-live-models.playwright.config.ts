import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.RYU_IMAGE_EDITOR_E2E_PORT ?? "5196");
const baseURL = `http://127.0.0.1:${port}/`;

export default defineConfig({
	fullyParallel: false,
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	reporter: "list",
	testDir: ".",
	testMatch: "image-editor-live-models.smoke.ts",
	timeout: 20 * 60 * 1000,
	use: { baseURL, trace: "on-first-retry" },
	webServer: {
		cwd: "..",
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.image-editor-proof.config.ts",
		reuseExistingServer: true,
		timeout: 120_000,
		url: baseURL,
	},
});
