import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig, type Plugin, type UserConfig } from "vite";

// Serves one unchanged gateway-specs-a proof harness on a caller-chosen port
// with a caller-owned dependency cache. Several of these harnesses share a
// fixed port with other proofs (5298 serves both the dialog shell and the
// workspace members story) or a package-wide cache, so concurrent coverage
// runs would collide. Each config is loaded lazily so only the requested
// harness's config (and its plugins) runs.
const harnesses: Record<string, () => Promise<{ default: UserConfig }>> = {
	"api-keys": () => import("./vite.gateway-api-keys-proof.config.ts"),
	"audit-log": () => import("./vite.gateway-audit-log-proof.config.ts"),
	"byok-integration": () =>
		import("./vite.gateway-byok-integration-proof.config.ts"),
	"byok-row": () => import("./vite.gateway-byok-row-proof.config.ts"),
	"cli-setup": () => import("./vite.gateway-cli-setup-proof.config.ts"),
	"dialog-accounts": () =>
		import("./vite.gateway-dialog-accounts-proof.config.ts"),
	"dialog-shell": () => import("./vite.gateway-dialog-shell-proof.config.ts"),
	"eval-result-tooltip": () =>
		import("./vite.gateway-eval-result-tooltip-proof.config.ts"),
	"evals-health": () => import("./vite.gateway-evals-health-proof.config.ts"),
	// The posture doctor and governance stories have no harness config of
	// their own; they are pages of the shared harness.
	generic: () => import("./vite.harness.config.ts"),
	guardrails: () =>
		import("./vite.gateway-guardrails-settings-proof.config.ts"),
	"hooks-mcp": () => import("./vite.gateway-hooks-mcp-proof.config.ts"),
	"inline-evaluator-editor": () =>
		import("./vite.gateway-inline-evaluator-editor-proof.config.ts"),
	"modality-routing": () =>
		import("./vite.gateway-modality-routing-proof.config.ts"),
	"model-mapping": () => import("./vite.gateway-model-mapping-proof.config.ts"),
	polling: () => import("./vite.settings-dialog-shortcuts-proof.config.ts"),
	"posture-card": () => import("./vite.gateway-posture-card-proof.config.ts"),
	"project-environments": () =>
		import("./vite.gateway-project-environments-proof.config.ts"),
	"provider-routing": () =>
		import("./vite.provider-routing-regressions-proof.config.ts"),
	"smart-routing": () =>
		import("./vite.gateway-smart-routing-settings-proof.config.ts"),
	"usage-cost": () => import("./vite.gateway-usage-cost-proof.config.ts"),
	"web-service-accounts": () =>
		import("./vite.web-service-accounts-proof.config.ts"),
	workspace: () => import("./vite.gateway-workspace-members-proof.config.ts"),
};

// Pages the shared harness should pre-bundle for, so a first visit does not
// trigger a mid-test dependency re-optimisation and reload.
const extraEntries: Record<string, string[]> = {
	generic: [
		"gateway-posture-doctor-proof.html",
		"gateway-governance-proof.html",
	],
};

const name = process.env.RYU_GATEWAY_SPECS_A_HARNESS ?? "";
const loadBase = harnesses[name];
if (!loadBase) {
	throw new Error(
		`RYU_GATEWAY_SPECS_A_HARNESS must name one of: ${Object.keys(harnesses).join(", ")}`
	);
}
const port = Number(process.env.RYU_GATEWAY_SPECS_A_PORT);
if (!Number.isInteger(port) || port <= 0) {
	throw new Error("RYU_GATEWAY_SPECS_A_PORT must be a TCP port");
}
const cacheRoot =
	process.env.RYU_GATEWAY_SPECS_A_VITE_CACHE ?? "/tmp/gateway-specs-a-pw/vite";

/** Optional mutation check: serves the scratch file named by
 * RYU_GATEWAY_SPECS_A_MUTANT_SOURCE in place of the shipping module named by
 * RYU_GATEWAY_SPECS_A_MUTANT_TARGET (both absolute). The shipping file is never
 * modified; relative imports keep resolving from the shipping module's
 * directory. Without both variables the harness serves shipping code only. */
function mutantSubstitution(): Plugin[] {
	const target = process.env.RYU_GATEWAY_SPECS_A_MUTANT_TARGET;
	const source = process.env.RYU_GATEWAY_SPECS_A_MUTANT_SOURCE;
	if (!(target || source)) {
		return [];
	}
	if (
		!(target && source && path.isAbsolute(target) && path.isAbsolute(source))
	) {
		throw new Error("Mutant target and source must both be absolute paths");
	}
	const code = readFileSync(source, "utf8");
	return [
		{
			name: "gateway-specs-a-mutant",
			enforce: "pre",
			load(id) {
				if (id.split("?")[0] !== target) {
					return null;
				}
				process.stderr.write(`[gateway-specs-a] mutant served for ${target}\n`);
				return code;
			},
		},
	];
}

/** The installed full Chromium build (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
 * requests /favicon.ico, which no proof harness serves; the headless shell the
 * proofs were written against does not. Answer it with an empty 204 so each
 * proof's console-error check keeps covering the app and nothing else. */
function emptyFavicon(): Plugin {
	return {
		name: "gateway-specs-a-empty-favicon",
		configureServer(server) {
			server.middlewares.use("/favicon.ico", (_request, response) => {
				response.statusCode = 204;
				response.end();
			});
		},
	};
}

export default async (): Promise<UserConfig> =>
	mergeConfig((await loadBase()).default, {
		cacheDir: `${cacheRoot}/${name}`,
		optimizeDeps: { entries: extraEntries[name] ?? [] },
		plugins: [emptyFavicon(), ...mutantSubstitution()],
		server: { host: "127.0.0.1", port, strictPort: true },
	});
