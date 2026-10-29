import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5285/";

export default defineConfig({
	testDir: ".",
	testMatch: /workflows-node-config-proof\.spec\.ts$/,
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
			"bunx vite build --config ../../apps-store/workflows/ui/vite.config.ts --outDir /tmp/ryu-workflows-node-config-coverage-build && bun e2e/workflows-node-config-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
