import { defineConfig, devices } from "@playwright/test";

// island-background-keys coverage run: the existing Island, Backgrounds,
// keyboard-shortcut, split-preset and time-zone browser proofs plus the new
// island-background-keys specs, each against its unchanged harness. Ports,
// the Vite cache and Playwright output are caller-owned so the run never
// touches another agent's servers or the tracked proof evidence.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const viteCache = process.env.RYU_IBK_VITE_CACHE ?? "/tmp/ibk-pw/vite";
const portBase = Number(process.env.RYU_IBK_PORT_BASE ?? "5731");
const LINUX_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const harnesses = [
	{
		name: "island",
		ready: "",
		spec: /island-settings-proof\.spec\.ts$/,
		use: {
			userAgent: LINUX_USER_AGENT,
			viewport: { height: 900, width: 1440 },
		},
	},
	{
		name: "background",
		ready: "",
		spec: /(?:background-customization-proof|island-background-keys-backgrounds)\.spec\.ts$/,
		use: {},
	},
	{
		name: "keyboard",
		ready: "",
		spec: /keyboard-shortcuts-proof\.spec\.ts$/,
		use: {},
	},
	{
		name: "keyboard-authority",
		ready: "",
		spec: /keyboard-shortcuts-authority-proof\.spec\.ts$/,
		use: {},
	},
	{
		name: "split",
		ready: "",
		spec: /(?:split-preset-settings-proof|island-background-keys-split-presets)\.spec\.ts$/,
		use: {},
	},
	{
		name: "timezone",
		ready: "timezone-picker-story.html",
		spec: /(?:timezone-picker-story|island-background-keys-timezone)\.spec\.ts$/,
		use: {},
	},
	{
		name: "click-modifiers",
		ready: "island-background-keys-click-modifiers.html",
		spec: /island-background-keys-click-modifiers\.spec\.ts$/,
		use: {},
	},
] as const;

// RYU_IBK_HARNESSES=island,background starts only those harness servers, so a
// focused run (or a mutant run) never boots the other Vite servers. Ports stay
// tied to each harness's position in the full list.
const only = new Set(
	(process.env.RYU_IBK_HARNESSES ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0)
);
const selected = harnesses
	.map((harness, index) => ({ ...harness, port: portBase + index }))
	.filter((harness) => only.size === 0 || only.has(harness.name));

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	reporter: "list",
	timeout: 90_000,
	outputDir: process.env.RYU_IBK_PW_OUTPUT ?? "/tmp/ibk-pw/out",
	projects: selected.map((harness) => ({
		name: harness.name,
		testMatch: harness.spec,
		use: {
			...devices["Desktop Chrome"],
			...harness.use,
			acceptDownloads: true,
			baseURL: `http://127.0.0.1:${harness.port}/`,
			launchOptions: executablePath ? { executablePath } : {},
			trace: "off" as const,
		},
	})),
	webServer: selected.map((harness) => ({
		command: "bunx vite --config harness/vite.island-background-keys.config.ts",
		env: {
			RYU_IBK_HARNESS: harness.name,
			RYU_IBK_PORT: String(harness.port),
			RYU_IBK_VITE_CACHE: viteCache,
			...(process.env.RYU_IBK_OVERRIDE_TARGET &&
			process.env.RYU_IBK_OVERRIDE_FILE
				? {
						RYU_IBK_OVERRIDE_FILE: process.env.RYU_IBK_OVERRIDE_FILE,
						RYU_IBK_OVERRIDE_TARGET: process.env.RYU_IBK_OVERRIDE_TARGET,
					}
				: {}),
		},
		url: `http://127.0.0.1:${harness.port}/${harness.ready}`,
		reuseExistingServer: false,
		timeout: 180_000,
	})),
});
