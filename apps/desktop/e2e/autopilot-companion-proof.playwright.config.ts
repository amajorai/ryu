import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const autopilotRoot = path.join(repositoryRoot, "apps-store/autopilot/ui");
const configuredHtml = process.env.RYU_AUTOPILOT_BUILD_HTML;
const existingBuildHtml =
	configuredHtml && existsSync(configuredHtml) ? configuredHtml : undefined;
const buildDirectory = existingBuildHtml
	? path.dirname(existingBuildHtml)
	: mkdtempSync(path.join(os.tmpdir(), "ryu-autopilot-ui-"));

if (!existingBuildHtml) {
	execFileSync(
		"bun",
		[
			"x",
			"vite",
			"build",
			"--config",
			"vite.config.ts",
			"--outDir",
			buildDirectory,
		],
		{ cwd: autopilotRoot, stdio: "inherit" }
	);

	process.env.RYU_AUTOPILOT_BUILD_HTML = path.join(
		buildDirectory,
		"index.html"
	);
	process.once("exit", () => {
		rmSync(buildDirectory, { force: true, recursive: true });
	});
}

const port = 53_427;
const baseURL = `http://127.0.0.1:${port}/`;

export default defineConfig({
	testDir: ".",
	testMatch: /autopilot-companion-proof\.autopilot\.ts$/u,
	// Pays the cold Vite compile of the proof page once, outside every test.
	globalSetup: "./harness/autopilot-companion-proof.global-setup.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	reporter: "list",
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		trace: "on-first-retry",
	},
	webServer: {
		command:
			"node node_modules/vite/bin/vite.js --config e2e/harness/vite.autopilot-companion-proof.config.ts",
		cwd: desktopRoot,
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
		env: { ...process.env, RYU_E2E_PORT: String(port) },
	},
});
