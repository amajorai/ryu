import { tmpdir } from "node:os";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5397/";

export default defineConfig({
	// Fresh runs may use test-results/memory-library-<run>; this canonical
	// directory is ignored by Git and Vite, so traces cannot drive CSS reloads.
	outputDir:
		process.env.RYU_MEMORY_LIBRARY_TEST_RESULTS_DIR ??
		`${tmpdir()}/ryu-memory-library-playwright-results`,
	testDir: ".",
	testMatch: /memory-library-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "bunx vite --config harness/vite.memory-library-proof.config.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
