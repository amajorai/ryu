import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5469/";

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-social-inbox-playwright`,
	testDir: ".",
	testMatch: /social-inbox-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	timeout: 60_000,
	use: {
		actionTimeout: 12_000,
		baseURL,
		...devices["Desktop Chrome"],
		viewport: { width: 1600, height: 1100 },
	},
	webServer: {
		command: `bun x vite build --config ../../apps-store/social/ui/vite.config.ts --outDir '${path.join(tmpdir(), "ryu-social-inbox-build").replaceAll("'", "'\\''")}' && bun x vite --config e2e/harness/vite.harness.config.ts --port 5469 --strictPort`,
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}social-inbox-proof.html`,
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
