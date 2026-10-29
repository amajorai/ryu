import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const e2eRoot = path.resolve(import.meta.dirname);
const baseURL = "http://127.0.0.1:5397/";
const proofViteConfig = path.resolve(
	e2eRoot,
	"harness/vite.editor-embedding-settings-proof.config.ts"
);

export default defineConfig({
	outputDir: `${tmpdir()}/ryu-editor-embedding-settings-playwright-results`,
	testDir: e2eRoot,
	testMatch: /editor-embedding-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		trace: "retain-on-failure",
	},
	webServer: {
		command: `bunx vite --config ${proofViteConfig}`,
		cwd: e2eRoot,
		url: `${baseURL}editor-embedding-settings-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
