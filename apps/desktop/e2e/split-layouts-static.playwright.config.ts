import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Build the corresponding authentic Vite harness first, then release the build
// process before Chromium starts. This preserves production CSS and code while
// keeping the resource-heavy compiler and browser in separate stages.
const kind = process.env.RYU_SPLIT_LAYOUT_PROOF;
if (kind !== "menu" && kind !== "settings") {
	throw new Error("RYU_SPLIT_LAYOUT_PROOF must be menu or settings");
}
const directory = path.resolve(
	process.env.RYU_SPLIT_LAYOUT_DIST ?? `/tmp/ryu-split-layout-${kind}`
);
const html =
	kind === "menu"
		? "split-presets-proof.html"
		: "split-preset-settings-proof.html";
if (!existsSync(path.join(directory, html))) {
	throw new Error(
		`Build the authentic ${kind} Vite harness into ${directory} before running browser tests`
	);
}
const port = kind === "menu" ? 5208 : 5259;
const url = `http://127.0.0.1:${port}/`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export default defineConfig({
	testDir: ".",
	testMatch:
		kind === "menu"
			? /split-presets-proof\.spec\.ts$/
			: /split-preset-settings-proof\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	timeout: 90_000,
	use: { baseURL: url, actionTimeout: 8000, trace: "retain-on-failure" },
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				// Opt-in installed Chromium when the locked Playwright build is absent.
				launchOptions: {
					executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
				},
			},
		},
	],
	webServer: {
		command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory ${quote(directory)}`,
		url: `${url}${html}`,
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
