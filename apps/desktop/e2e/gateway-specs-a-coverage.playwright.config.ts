import path from "node:path";
import { defineConfig, devices, type Project } from "@playwright/test";

// Runs the existing Gateway section browser proofs (Overview posture and
// doctor, polling, Workspace, provider keys and BYOK, smart/modality routing
// and model mapping, guardrails, runtime controls, hooks and MCP, project
// environments, governance, the dialog shell and accounts, provider routing
// regressions, web service accounts, client API keys and CLI setup, usage and
// cost, the audit log, and evals and health) with an explicit Chromium binary and
// caller-owned output, cache and evidence directories. Each proof keeps its own
// harness; harness/vite.gateway-specs-a-coverage serves it on its own port so
// this run never collides with another proof that shares the harness's fixed
// port. RYU_GATEWAY_SPECS_A_ONLY (comma-separated project names) limits which
// projects run and so which harness servers start. Each project keeps the
// timeout, viewport and permissions of the proof's own config.
const output =
	process.env.RYU_GATEWAY_SPECS_A_OUTPUT ?? "/tmp/gateway-specs-a-pw";
// The proofs refresh committed evidence screenshots by default; a coverage run
// writes them to scratch so the tracked proof ledger stays untouched.
process.env.RYU_PROOF_EVIDENCE_DIR ??= `${output}/evidence`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const viteCache =
	process.env.RYU_GATEWAY_SPECS_A_VITE_CACHE ?? `${output}/vite`;
const only = process.env.RYU_GATEWAY_SPECS_A_ONLY;
const desktopRoot = path.resolve(import.meta.dirname, "..");
const harnessConfig = path.resolve(
	import.meta.dirname,
	"harness/vite.gateway-specs-a-coverage.config.ts"
);

/** One harness server: a proof harness config served on its own port. A
 * harness whose own config ran Vite from the Desktop package root (its
 * Tailwind/PostCSS imports resolve from the working directory) sets
 * `fromDesktopRoot`. Ports sit below Linux's ephemeral range (32768-60999) so
 * an outbound connection's local port cannot already hold one. */
const harnessPorts: Record<
	string,
	{ fromDesktopRoot?: boolean; page: string; port: number }
> = {
	"posture-card": { port: 29_301, page: "gateway-posture-card-proof.html" },
	generic: { port: 29_302, page: "gateway-posture-doctor-proof.html" },
	polling: { port: 29_303, page: "settings-dialog-shortcuts-proof.html" },
	workspace: { port: 29_304, page: "gateway-workspace-members-proof.html" },
	"byok-integration": {
		port: 29_305,
		page: "gateway-byok-integration-proof.html",
	},
	"byok-row": { port: 29_306, page: "gateway-byok-row-proof.html" },
	"smart-routing": {
		port: 29_307,
		page: "gateway-smart-routing-settings-proof.html",
	},
	"modality-routing": {
		port: 29_308,
		page: "gateway-modality-routing-proof.html",
	},
	"model-mapping": { port: 29_309, page: "gateway-model-mapping-proof.html" },
	guardrails: { port: 29_310, page: "gateway-guardrails-settings-proof.html" },
	"dialog-shell": { port: 29_311, page: "gateway-dialog-shell-proof.html" },
	"hooks-mcp": { port: 29_312, page: "gateway-hooks-mcp-proof.html" },
	"project-environments": {
		port: 29_313,
		page: "gateway-project-environments-proof.html",
	},
	"dialog-accounts": {
		port: 29_314,
		page: "gateway-dialog-accounts-proof.html",
	},
	"web-service-accounts": {
		port: 29_315,
		page: "web-service-accounts-proof.html",
	},
	"provider-routing": {
		port: 29_316,
		page: "provider-routing-regressions-proof.html",
		fromDesktopRoot: true,
	},
	"api-keys": { port: 29_317, page: "gateway-api-keys-proof.html" },
	"cli-setup": { port: 29_318, page: "gateway-cli-setup-proof.html" },
	"usage-cost": { port: 29_319, page: "gateway-usage-cost-proof.html" },
	"audit-log": { port: 29_320, page: "gateway-audit-log-proof.html" },
	"evals-health": { port: 29_321, page: "gateway-evals-health-proof.html" },
	"eval-result-tooltip": {
		port: 29_322,
		page: "gateway-eval-result-tooltip-proof.html",
	},
	"inline-evaluator-editor": {
		port: 29_323,
		page: "gateway-inline-evaluator-editor-proof.html",
	},
};

interface Proof {
	/** Keep the Desktop Chrome device profile the proof's own config used. */
	device?: boolean;
	harness: keyof typeof harnessPorts;
	name: string;
	spec: RegExp;
	timeout?: number;
	use?: Project["use"];
}

const proofs: Proof[] = [
	{
		name: "posture-card",
		spec: /gateway-posture-card-proof\.spec\.ts$/,
		harness: "posture-card",
		use: { permissions: ["clipboard-read", "clipboard-write"] },
	},
	{
		name: "posture-doctor",
		spec: /gateway-posture-doctor-proof\.spec\.ts$/,
		harness: "generic",
	},
	{
		name: "polling",
		spec: /gateway-polling-proof\.spec\.ts$/,
		harness: "polling",
	},
	{
		name: "workspace-members",
		spec: /gateway-workspace-members-proof\.spec\.ts$/,
		harness: "workspace",
	},
	{
		name: "workspace-section-controls",
		spec: /gateway-workspace-section-controls-proof\.spec\.ts$/,
		harness: "workspace",
	},
	{
		name: "byok-integration",
		spec: /gateway-byok-integration-proof\.spec\.ts$/,
		harness: "byok-integration",
	},
	{
		name: "byok-row",
		spec: /gateway-byok-row-proof\.spec\.ts$/,
		harness: "byok-row",
	},
	{
		name: "smart-routing",
		spec: /gateway-smart-routing-settings-proof\.spec\.ts$/,
		harness: "smart-routing",
	},
	{
		name: "modality-routing",
		spec: /gateway-modality-routing-proof\.spec\.ts$/,
		harness: "modality-routing",
		// The first visit waits for Vite to optimise the shared dependencies.
		timeout: 90_000,
		use: { navigationTimeout: 90_000 },
	},
	{
		name: "model-mapping",
		spec: /gateway-model-mapping-proof\.spec\.ts$/,
		harness: "model-mapping",
	},
	{
		name: "guardrails",
		spec: /gateway-guardrails-settings-proof\.spec\.ts$/,
		harness: "guardrails",
	},
	{
		name: "runtime-controls",
		spec: /gateway-runtime-controls-proof\.spec\.ts$/,
		harness: "dialog-shell",
		use: { navigationTimeout: 120_000 },
	},
	{
		name: "hooks-mcp",
		spec: /gateway-hooks-mcp-proof\.spec\.ts$/,
		harness: "hooks-mcp",
	},
	{
		name: "project-environments",
		spec: /gateway-project-environments-proof\.spec\.ts$/,
		harness: "project-environments",
	},
	{
		name: "governance",
		spec: /gateway-governance-proof\.spec\.ts$/,
		harness: "generic",
	},
	{
		name: "dialog-shell",
		spec: /gateway-dialog-shell-proof\.spec\.ts$/,
		harness: "dialog-shell",
	},
	{
		name: "dialog-accounts",
		spec: /gateway-dialog-accounts-proof\.spec\.ts$/,
		harness: "dialog-accounts",
		device: false,
		timeout: 90_000,
		use: { viewport: { width: 1440, height: 1000 } },
	},
	{
		name: "web-service-accounts",
		spec: /web-service-accounts-proof\.spec\.ts$/,
		harness: "web-service-accounts",
		device: false,
		timeout: 90_000,
		use: { viewport: { width: 1280, height: 1000 } },
	},
	{
		name: "provider-routing",
		spec: /provider-routing-regressions-proof\.spec\.ts$/,
		harness: "provider-routing",
		device: false,
		timeout: 600_000,
		use: { viewport: { width: 1280, height: 1000 } },
	},
	{
		name: "api-keys",
		spec: /gateway-api-keys-proof\.spec\.ts$/,
		harness: "api-keys",
	},
	{
		name: "cli-setup",
		spec: /gateway-cli-setup-proof\.spec\.ts$/,
		harness: "cli-setup",
		device: false,
		use: { viewport: { width: 1280, height: 900 } },
	},
	{
		name: "usage-cost",
		spec: /gateway-usage-cost-proof\.spec\.ts$/,
		harness: "usage-cost",
		timeout: 90_000,
	},
	{
		name: "audit-log",
		spec: /gateway-audit-log-proof\.spec\.ts$/,
		harness: "audit-log",
	},
	{
		name: "evals-health",
		spec: /gateway-evals-health-proof\.spec\.ts$/,
		harness: "evals-health",
	},
	{
		name: "eval-result-tooltip",
		spec: /gateway-eval-result-tooltip-proof\.spec\.ts$/,
		harness: "eval-result-tooltip",
		timeout: 90_000,
	},
	{
		name: "inline-evaluator-editor",
		spec: /gateway-inline-evaluator-editor-proof\.spec\.ts$/,
		harness: "inline-evaluator-editor",
		use: { viewport: { width: 1440, height: 900 } },
	},
].filter((proof) => !only || only.split(",").includes(proof.name));

const servedHarnesses = [...new Set(proofs.map((proof) => proof.harness))];

export default defineConfig({
	testDir: ".",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: true,
	reporter: "list",
	outputDir: `${output}/results`,
	projects: proofs.map((proof) => ({
		name: proof.name,
		testMatch: proof.spec,
		...(proof.timeout ? { timeout: proof.timeout } : {}),
		use: {
			...(proof.device === false ? {} : devices["Desktop Chrome"]),
			...proof.use,
			baseURL: `http://127.0.0.1:${harnessPorts[proof.harness].port}/`,
			launchOptions: executablePath ? { executablePath } : {},
			trace: "off" as const,
		},
	})),
	webServer: servedHarnesses.map((harness) => ({
		command: `bunx vite --config ${harnessConfig}`,
		cwd: harnessPorts[harness].fromDesktopRoot
			? desktopRoot
			: import.meta.dirname,
		env: {
			RYU_GATEWAY_SPECS_A_HARNESS: harness,
			RYU_GATEWAY_SPECS_A_PORT: String(harnessPorts[harness].port),
			RYU_GATEWAY_SPECS_A_VITE_CACHE: viteCache,
		},
		url: `http://127.0.0.1:${harnessPorts[harness].port}/${harnessPorts[harness].page}`,
		reuseExistingServer: false,
		timeout: 180_000,
	})),
});
