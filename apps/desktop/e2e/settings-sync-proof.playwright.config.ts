import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const proofUrl = "http://127.0.0.1:5207/";
const e2eRoot = path.resolve(process.cwd(), "e2e");
const desktopVite = path.resolve(e2eRoot, "../node_modules/vite/bin/vite.js");
const proofViteConfig = path.resolve(
	e2eRoot,
	"harness/vite.settings-sync-proof.config.ts"
);

export default defineConfig({
	testDir: ".",
	testMatch: /settings-sync-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	timeout: 60_000,
	use: { baseURL: proofUrl, trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: `node ${desktopVite} --config ${proofViteConfig}`,
		cwd: e2eRoot,
		url: `${proofUrl}settings-sync-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
