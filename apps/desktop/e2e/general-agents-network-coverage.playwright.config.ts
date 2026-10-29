import { defineConfig, devices, type Project } from "@playwright/test";

// Runs the existing browser proofs for the General, A2A, agent access, memory,
// editor embedding, network, node access and app updates settings with the
// host Chromium. Screenshots and results go under /tmp so tracked proof images
// stay untouched. RYU_GENERAL_AGENTS_NETWORK_ONLY (comma-separated project
// names) limits which harness servers start, since each needs its own Vite.
const output =
	process.env.RYU_GENERAL_AGENTS_NETWORK_OUTPUT ??
	"/tmp/general-agents-network-coverage";
process.env.RYU_PROOF_EVIDENCE_DIR ??= `${output}/evidence`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

interface Proof {
	harness: string;
	name: string;
	page: string;
	port: number;
	spec: RegExp;
	use?: Project["use"];
}

const proofs: Proof[] = [
	{
		name: "a2a-settings",
		spec: /a2a-settings-proof\.spec\.ts$/,
		harness: "a2a-proof.vite.config.ts",
		port: 5188,
		page: "a2a-settings-proof.html",
		use: { permissions: ["clipboard-read", "clipboard-write"] },
	},
	{
		name: "agent-access-settings",
		spec: /agent-access-settings-proof\.spec\.ts$/,
		harness: "vite.agent-access-settings-proof.config.ts",
		port: 5388,
		page: "agent-access-settings-proof.html",
		use: { viewport: { width: 1440, height: 1200 } },
	},
	{
		name: "desktop-general-settings",
		spec: /desktop-general-settings-proof\.spec\.ts$/,
		harness: "vite.desktop-general-settings-proof.config.ts",
		port: 5201,
		page: "desktop-general-settings-proof.html",
	},
	{
		name: "memory-settings",
		spec: /memory-settings-proof\.spec\.ts$/,
		harness: "vite.memory-settings-proof.config.ts",
		port: 5395,
		page: "memory-settings-proof.html",
	},
	{
		name: "editor-embedding-settings",
		spec: /editor-embedding-settings-proof\.spec\.ts$/,
		harness: "vite.editor-embedding-settings-proof.config.ts",
		port: 5397,
		page: "editor-embedding-settings-proof.html",
		use: { trace: "retain-on-failure" },
	},
	{
		name: "mesh-auto-install",
		spec: /mesh-auto-install-proof\.spec\.ts$/,
		harness: "vite.mesh-auto-install-proof.config.ts",
		port: 5250,
		page: "mesh-auto-install-proof.html",
	},
	{
		name: "scoped-pairing",
		spec: /scoped-pairing-proof\.spec\.ts$/,
		harness: "vite.scoped-pairing-proof.config.ts",
		port: 5231,
		page: "scoped-pairing-proof.html",
		use: { locale: "en-US", timezoneId: "UTC" },
	},
	{
		name: "app-updates-settings",
		spec: /app-updates-settings-proof\.spec\.ts$/,
		harness: "vite.app-updates-settings-proof.config.ts",
		port: 5206,
		page: "app-updates-settings-proof.html",
	},
];

const only = new Set(
	(process.env.RYU_GENERAL_AGENTS_NETWORK_ONLY ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean)
);
const selected = only.size
	? proofs.filter((proof) => only.has(proof.name))
	: proofs;

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	reporter: "list",
	outputDir: `${output}/results`,
	use: {
		...devices["Desktop Chrome"],
		launchOptions: executablePath ? { executablePath } : {},
		trace: "off",
	},
	projects: selected.map((proof) => ({
		name: proof.name,
		testMatch: proof.spec,
		use: {
			...devices["Desktop Chrome"],
			baseURL: `http://127.0.0.1:${proof.port}/`,
			launchOptions: executablePath ? { executablePath } : {},
			...proof.use,
		},
	})),
	webServer: selected.map((proof) => ({
		command: `RYU_GENERAL_AGENTS_NETWORK_HARNESS=${proof.harness} bunx vite --config harness/vite.general-agents-network-coverage.config.ts`,
		url: `http://127.0.0.1:${proof.port}/${proof.page}`,
		reuseExistingServer: false,
		timeout: 180_000,
	})),
});
