import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const harnessDir = path.resolve(import.meta.dirname, "harness");
path.resolve(harnessDir, "../..");
const port = Number(process.env.RYU_BOT_REALM_E2E_PORT ?? "5178");

export default defineConfig({
	testDir: ".",
	testMatch: /bot-realm-defaults-proof\.spec\.ts$/,
	fullyParallel: false,
	use: {
		baseURL: `http://127.0.0.1:${port}/`,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		command:
			"node ../node_modules/vite/bin/vite.js --config harness/vite.bot-realm-defaults-proof.config.ts",
		url: `http://127.0.0.1:${port}/`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
