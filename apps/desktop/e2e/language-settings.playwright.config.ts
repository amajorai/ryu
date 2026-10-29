import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.RYU_E2E_PORT ?? "5190");
const baseURL = `http://127.0.0.1:${port}`;
const cacheDir =
	process.env.RYU_LANGUAGE_VITE_CACHE ??
	mkdtempSync(path.join(tmpdir(), "ryu-language-vite-"));
const staticBuild = process.env.RYU_LANGUAGE_STATIC_BUILD === "1";
export default defineConfig({
	testDir: ".",
	testMatch: /language-settings-storage\.spec\.ts$/,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	reporter: "line",
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		locale: "en-US",
		// Opt-in installed Chromium when the locked Playwright build is absent.
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: {
		command: `node node_modules/vite/bin/vite.js ${staticBuild ? "preview " : ""}--config e2e/harness/vite.language-settings.config.ts`,
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}/language-settings-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
		env: { RYU_LANGUAGE_VITE_CACHE: cacheDir },
	},
});
