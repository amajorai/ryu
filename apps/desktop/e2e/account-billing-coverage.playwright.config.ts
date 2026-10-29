import { defineConfig, devices } from "@playwright/test";

// Runs the existing Account, Profile, Billing and Teams billing browser proofs
// against their unchanged harnesses with an explicit Chromium binary and
// caller-owned output, cache and evidence directories. Each harness keeps its
// own port and becomes one project.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const viteCache =
	process.env.RYU_ACCOUNT_BILLING_VITE_CACHE ?? "/tmp/account-billing-pw/vite";
const only = process.env.RYU_ACCOUNT_BILLING_ONLY;
// The proofs refresh committed evidence screenshots by default; a coverage run
// writes them to scratch so the tracked proof ledger stays untouched.
process.env.RYU_PROOF_EVIDENCE_DIR ??= "/tmp/account-billing-pw/evidence";

const harnesses = [
	{
		name: "account",
		port: 5224,
		spec: /developer-account-sessions-settings-proof\.spec\.ts$/,
		viewport: undefined,
	},
	{
		name: "profile",
		port: 55_813,
		spec: /profile-tab-settings-proof\.spec\.ts$/,
		viewport: { height: 1000, width: 1440 },
	},
	{
		name: "billing",
		port: 5343,
		spec: /billing-tab-proof\.spec\.ts$/,
		// The billing proof's own config pins a Linux Chrome user agent.
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
		viewport: { height: 900, width: 1440 },
	},
	{
		name: "teams",
		port: 5367,
		spec: /teams-billing-settings-proof\.spec\.ts$/,
		viewport: { height: 900, width: 1440 },
	},
].filter((harness) => !only || only.split(",").includes(harness.name));

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	outputDir:
		process.env.RYU_ACCOUNT_BILLING_PW_OUTPUT ?? "/tmp/account-billing-pw/out",
	projects: harnesses.map((harness) => ({
		name: harness.name,
		testMatch: harness.spec,
		timeout: 120_000,
		use: {
			...devices["Desktop Chrome"],
			...(harness.viewport ? { viewport: harness.viewport } : {}),
			...("userAgent" in harness ? { userAgent: harness.userAgent } : {}),
			acceptDownloads: true,
			baseURL: `http://127.0.0.1:${harness.port}/`,
			launchOptions: executablePath ? { executablePath } : {},
			trace: "off",
		},
	})),
	webServer: harnesses.map((harness) => ({
		command:
			"bunx vite --config harness/vite.account-billing-coverage.config.ts",
		env: {
			RYU_ACCOUNT_BILLING_HARNESS: harness.name,
			RYU_ACCOUNT_BILLING_VITE_CACHE: viteCache,
		},
		url:
			harness.name === "profile"
				? `http://127.0.0.1:${harness.port}/profile-tab-settings-proof.html`
				: `http://127.0.0.1:${harness.port}/`,
		reuseExistingServer: false,
		timeout: 120_000,
	})),
});
