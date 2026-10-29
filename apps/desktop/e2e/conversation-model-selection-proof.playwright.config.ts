import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.RYU_MODEL_SELECTION_E2E_PORT ?? "5192");
const baseURL = `http://127.0.0.1:${port}/`;

export default defineConfig({
	fullyParallel: false,
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	reporter: "list",
	testDir: ".",
	testMatch: "conversation-model-selection-proof.spec.ts",
	timeout: 120_000,
	use: { baseURL, trace: "on-first-retry" },
	webServer: {
		cwd: "..",
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.conversation-model-selection-proof.config.ts",
		reuseExistingServer:
			process.env.RYU_MODEL_SELECTION_E2E_REUSE_SERVER === "1",
		timeout: 120_000,
		url: baseURL,
	},
});
