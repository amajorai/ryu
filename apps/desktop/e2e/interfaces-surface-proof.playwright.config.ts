import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

// The real desktop App (Layout in OS product mode with a workspace interface
// active), over the console-access fixture's mocked Core and control plane.
const baseURL = "http://127.0.0.1:5497";
export default defineConfig({
	testDir: ".",
	testMatch: /interfaces-surface-proof\.spec\.ts$/,
	workers: 1,
	fullyParallel: false,
	retries: 0,
	outputDir: `${tmpdir()}/ryu-interfaces-surface-proof-results`,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1280, height: 800 },
		trace: "retain-on-failure",
		// Sandboxes with a pre-installed Chromium point at it here.
		...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
			? {
					launchOptions: {
						executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
					},
				}
			: {}),
	},
	webServer: {
		command:
			"bun x vite --config harness/vite.console-access-app-proof.config.ts",
		url: `${baseURL}/console-access-app-proof.html`,
		reuseExistingServer: true,
		timeout: 180_000,
	},
});
