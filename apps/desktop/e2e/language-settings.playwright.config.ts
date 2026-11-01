import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.RYU_E2E_PORT ?? "5190");
const baseURL = `http://127.0.0.1:${port}`;
const cacheDir =
	process.env.RYU_LANGUAGE_VITE_CACHE ??
	mkdtempSync(path.join(tmpdir(), "ryu-language-vite-"));
// The harness's installed-icon plugin refuses to start without caller-owned
// icon map and diagnostic paths. Callers that pin their own map (the appearance
// proof runners) still pass both; a plain `playwright test` run generates a
// fresh map from the installed icon packages into its own temporary directory.
const iconDir = mkdtempSync(path.join(tmpdir(), "ryu-language-icons-"));
const iconMap =
	process.env.RYU_APPEARANCE_ICON_MAP ??
	path.join(iconDir, "installed-icon-map.json");
const iconDiagnostic =
	process.env.RYU_APPEARANCE_ICON_DIAGNOSTIC ??
	path.join(iconDir, "installed-icons-diagnostic.json");
if (!process.env.RYU_APPEARANCE_ICON_MAP) {
	const desktop = path.resolve(import.meta.dirname, "..");
	execFileSync(process.execPath, [
		path.resolve(desktop, "../../tools/generate-installed-icon-map.mjs"),
		desktop,
		iconMap,
	]);
}
const staticBuild = process.env.RYU_LANGUAGE_STATIC_BUILD === "1";
export default defineConfig({
	testDir: ".",
	testMatch: /language-settings-(storage|keyboard)\.spec\.ts$/,
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
		env: {
			RYU_LANGUAGE_VITE_CACHE: cacheDir,
			RYU_APPEARANCE_ICON_MAP: iconMap,
			RYU_APPEARANCE_ICON_DIAGNOSTIC: iconDiagnostic,
		},
	},
});
