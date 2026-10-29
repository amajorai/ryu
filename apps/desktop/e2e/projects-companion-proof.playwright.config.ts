import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = 62_843;
const baseURL = `http://127.0.0.1:${port}/`;

export default defineConfig({
	testDir: ".",
	testMatch: /projects-companion-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	use: {
		actionTimeout: 10_000,
		baseURL,
		viewport: { width: 1600, height: 1100 },
		...devices["Desktop Chrome"],
	},
	webServer: {
		command:
			"bun run --cwd ../../apps-store/projects/ui build && bun e2e/projects-companion-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		env: { RYU_PROJECTS_PROOF_PORT: String(port) },
		timeout: 120_000,
	},
});
