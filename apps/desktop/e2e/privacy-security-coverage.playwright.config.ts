import { defineConfig, devices } from "@playwright/test";

// Runs the existing Privacy, Email & alerts, Encryption, Settings Sync and
// Settings dialog shell browser proofs against their unchanged harnesses with
// an explicit Chromium binary and caller-owned output directories. Each harness
// keeps its own Vite config and port. Set RYU_PROOF_OUTPUT_ROOT as well so the
// specs that write sweep evidence write it to scratch space instead.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const output =
	process.env.RYU_PRIVACY_SECURITY_PW_OUTPUT ?? "/tmp/privacy-security-pw";

const harnesses = [
	{
		name: "privacy-settings",
		port: 5205,
		ready: "privacy-settings-proof.html",
		spec: /privacy-settings-proof\.spec\.ts$/,
		vite: "harness/vite.privacy-settings-proof.config.ts",
	},
	{
		name: "email-alerts",
		port: 5267,
		ready: "email-alerts-settings-proof.html",
		spec: /email-alerts-settings-proof\.spec\.ts$/,
		vite: "harness/vite.email-alerts-settings-proof.config.ts",
	},
	{
		name: "gateway-encryption",
		port: 5254,
		ready: "gateway-encryption-settings-proof.html",
		spec: /gateway-encryption-settings-proof\.spec\.ts$/,
		vite: "harness/vite.gateway-encryption-settings-proof.config.ts",
	},
	{
		name: "settings-sync",
		port: 5207,
		ready: "settings-sync-proof.html",
		spec: /settings-sync-proof\.spec\.ts$/,
		vite: "harness/vite.settings-sync-proof.config.ts",
	},
	{
		name: "settings-dialog-shell",
		port: 5237,
		ready: "settings-dialog-shell-proof.html",
		spec: /settings-dialog-shell-proof\.spec\.ts$/,
		vite: "harness/vite.settings-dialog-shell-proof.config.ts",
	},
] as const;

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	timeout: 90_000,
	outputDir: `${output}/results`,
	projects: harnesses.map((harness) => ({
		name: harness.name,
		testMatch: harness.spec,
		use: {
			...devices["Desktop Chrome"],
			baseURL: `http://127.0.0.1:${harness.port}/`,
			launchOptions: executablePath ? { executablePath } : {},
			trace: "off",
		},
	})),
	webServer: harnesses.map((harness) => ({
		command: `bunx vite --config ${harness.vite}`,
		url: `http://127.0.0.1:${harness.port}/${harness.ready}`,
		reuseExistingServer: false,
		timeout: 120_000,
	})),
});
