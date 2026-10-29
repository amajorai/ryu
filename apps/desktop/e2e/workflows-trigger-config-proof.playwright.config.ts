import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5284/";

export default defineConfig({
	testDir: ".",
	testMatch: /workflows-trigger-config-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	use: {
		actionTimeout: 10_000,
		baseURL,
		viewport: { width: 1440, height: 1080 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bunx vite build --config ../../apps-store/workflows/ui/vite.config.ts --outDir /tmp/ryu-workflows-trigger-coverage-build && bun e2e/workflows-trigger-config-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
