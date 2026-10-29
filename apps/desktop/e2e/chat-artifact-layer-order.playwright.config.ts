import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Build `harness/vite.chat-artifact-layer-order-proof.config.ts` first; this
// serves that production-mode harness CSS/JS output without a dev server.
const directory = path.resolve(
	process.env.RYU_CHAT_ARTIFACT_LAYER_DIST ??
		path.join(tmpdir(), "ryu-chat-artifact-layer-order")
);
const html = "chat-artifact-layer-order-proof.html";
if (!existsSync(path.join(directory, html))) {
	throw new Error(
		`Build the chat artifact layer harness into ${directory} first`
	);
}
const port = 5263;
const url = `http://127.0.0.1:${port}/`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export default defineConfig({
	testDir: ".",
	testMatch: /chat-artifact-layer-order\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	timeout: 60_000,
	outputDir: path.join(tmpdir(), "ryu-chat-artifact-layer-order-results"),
	use: {
		...devices["Desktop Chrome"],
		baseURL: url,
		actionTimeout: 8000,
		trace: "retain-on-failure",
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: {
		command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory ${quote(directory)}`,
		url: `${url}${html}`,
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
