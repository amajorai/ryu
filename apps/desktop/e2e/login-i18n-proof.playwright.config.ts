import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

path.resolve(import.meta.dirname, "harness");
const port = Number(process.env.RYU_LOGIN_I18N_E2E_PORT ?? "5232");

export default defineConfig({
	testDir: ".",
	testMatch: /login-i18n-proof\.spec\.ts$/,
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
			"node ../node_modules/vite/bin/vite.js --config harness/vite.login-i18n-proof.config.ts",
		url: `http://127.0.0.1:${port}/`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
