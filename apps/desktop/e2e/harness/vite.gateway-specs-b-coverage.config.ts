import { readFileSync } from "node:fs";
import path from "node:path";
import {
	type ConfigEnv,
	mergeConfig,
	type Plugin,
	type UserConfig,
} from "vite";

// Serves one unchanged gateway-specs-b proof harness on a caller-chosen port
// with a caller-owned dependency cache, or builds the plugin-shortcut harness
// bundle (`vite build` with RYU_GATEWAY_SPECS_B_HARNESS=plugin-shortcuts-static
// and RYU_PLUGIN_SHORTCUTS_DIST). Several of these harnesses share a fixed port
// with other proofs (5178, 5411) and some use the package-wide default cache,
// so concurrent coverage runs would collide. Each config is loaded lazily so
// only the requested harness's config (and its plugins) runs.
const harnesses: Record<string, () => Promise<{ default: UserConfig }>> = {
	"agent-sync": () => import("./vite.agent-sync-proof.config.ts"),
	budgets: () => import("./vite.gateway-budgets-settings-proof.config.ts"),
	"node-selector": () => import("./vite.node-selector-proof.config.ts"),
	"plugin-shortcuts-static": () =>
		import("./plugin-shortcuts-proof/vite.static.config.ts"),
	"startup-performance": () =>
		import("./vite.startup-performance-proof.config.ts"),
};

const name = process.env.RYU_GATEWAY_SPECS_B_HARNESS ?? "";
const loadBase = harnesses[name];
if (!loadBase) {
	throw new Error(
		`RYU_GATEWAY_SPECS_B_HARNESS must name one of: ${Object.keys(harnesses).join(", ")}`
	);
}
const cacheRoot =
	process.env.RYU_GATEWAY_SPECS_B_VITE_CACHE ?? "/tmp/gateway-specs-b-pw/vite";

/** Optional mutation check: serves the scratch file named by
 * RYU_GATEWAY_SPECS_B_MUTANT_SOURCE in place of the shipping module named by
 * RYU_GATEWAY_SPECS_B_MUTANT_TARGET (both absolute). The shipping file is never
 * modified; relative imports keep resolving from the shipping module's
 * directory. Without both variables the harness serves shipping code only. */
function mutantSubstitution(): Plugin[] {
	const target = process.env.RYU_GATEWAY_SPECS_B_MUTANT_TARGET;
	const source = process.env.RYU_GATEWAY_SPECS_B_MUTANT_SOURCE;
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
			name: "gateway-specs-b-mutant",
			enforce: "pre",
			load(id) {
				if (id.split("?")[0] !== target) {
					return null;
				}
				process.stderr.write(`[gateway-specs-b] mutant served for ${target}\n`);
				return code;
			},
		},
	];
}

function devServer(): UserConfig["server"] {
	const port = Number(process.env.RYU_GATEWAY_SPECS_B_PORT);
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error("RYU_GATEWAY_SPECS_B_PORT must be a TCP port");
	}
	return { host: "127.0.0.1", port, strictPort: true };
}

export default async ({ command }: ConfigEnv): Promise<UserConfig> =>
	mergeConfig((await loadBase()).default, {
		cacheDir: `${cacheRoot}/${name}`,
		plugins: mutantSubstitution(),
		...(command === "serve" ? { server: devServer() } : {}),
	});
