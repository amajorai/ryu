import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const proofUrl = "http://127.0.0.1:5454";
const e2eRoot = path.resolve(process.cwd(), "e2e");
const viteBin = path.resolve(e2eRoot, "../node_modules/vite/bin/vite.js");
const viteConfig = path.resolve(
	e2eRoot,
	"harness/vite.add-channel-dialog-proof.config.ts"
);

export default defineConfig({
	testDir: ".",
	testMatch: /add-channel-dialog-interactions\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	timeout: 60_000,
	use: { baseURL: proofUrl, trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: `node ${viteBin} --config ${viteConfig}`,
		cwd: e2eRoot,
		url: `${proofUrl}/add-channel-dialog-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
