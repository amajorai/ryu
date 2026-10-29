import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5591/";

export default defineConfig({
	testDir: ".",
	testMatch: /convert-companion-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	timeout: 30_000,
	use: {
		actionTimeout: 10_000,
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 1000 },
	},
	webServer: {
		command:
			"bun x vite build --config ../../apps-store/convert/ui/vite.config.ts && bun x vite --config e2e/convert-companion-proof.vite.config.ts --host 127.0.0.1 --port 5591 --strictPort",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
