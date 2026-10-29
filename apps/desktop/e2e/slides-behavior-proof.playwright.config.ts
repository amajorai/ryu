import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:61417/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-slides-behavior-playwright-results`,
	testDir: ".",
	testMatch: /slides-behavior-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "line",
	use: {
		acceptDownloads: true,
		actionTimeout: 10_000,
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1880, height: 1600 },
	},
	webServer: {
		command:
			"bunx vite build --config ../../apps-store/slides/ui/vite.config.ts --outDir /tmp/ryu-slides-coverage-build && bunx vite --config e2e/harness/vite.harness.config.ts --port 61417 --strictPort",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}slides-companion-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
