import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5588/";

export default defineConfig({
	testDir: ".",
	testMatch: /clips-companion-proof\.spec\.ts$/,
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
		command: `bun x vite build --config ../../apps-store/clips/ui/vite.config.ts --outDir '${path.join(tmpdir(), "ryu-clips-companion-ui-build").replaceAll("'", "'\\''")}' && bun e2e/clips-companion-proof.host.ts`,
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
