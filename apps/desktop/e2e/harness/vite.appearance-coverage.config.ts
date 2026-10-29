import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig, type Plugin, type UserConfig } from "vite";
import consumerEffects from "./vite.appearance-consumer-effects-proof.config.ts";
import settingsProof from "./vite.appearance-settings-proof.config.ts";
import dialogShell from "./vite.settings-dialog-shell-proof.config.ts";

// Serves one of the three existing Appearance proof harnesses unchanged, except
// that the dependency cache lives under the caller-owned scratch directory
// instead of the shared checkout's node_modules.
const harnesses: Record<string, UserConfig> = {
	"consumer-effects": consumerEffects,
	"dialog-shell": dialogShell,
	settings: settingsProof,
};

const harnessName = process.env.RYU_APPEARANCE_COVERAGE_HARNESS ?? "";
const base = harnesses[harnessName];
if (!base) {
	throw new Error(
		`RYU_APPEARANCE_COVERAGE_HARNESS must be one of ${Object.keys(harnesses).join(", ")}`
	);
}
const cacheRoot =
	process.env.RYU_APPEARANCE_COVERAGE_VITE_CACHE ?? "/tmp/appearance-pw/vite";

// The settings harness declares no scan entry, so Vite's dependency scan walks
// every sibling harness page (several import Web-only modules it cannot
// resolve) and the first page load then waits on a mid-test re-optimisation.
// Scanning only the page under test keeps the cold start inside the budget.
const scanEntries: Record<string, string[]> = {
	settings: ["appearance-settings-proof.html"],
};

// Opt-in for baseline and mutant runs only: serve a scratch body in place of
// the shipping Appearance tab, so no shipping file is edited to run them.
const overrideTarget = path.resolve(
	import.meta.dirname,
	"../../src/components/settings/AppearanceTab.tsx"
);
const overrideFile = process.env.RYU_APPEARANCE_COVERAGE_OVERRIDE;
const overridePlugins: Plugin[] = overrideFile
	? [
			{
				enforce: "pre",
				load(id) {
					if (id.split("?")[0] !== overrideTarget) {
						return null;
					}
					process.stderr.write(
						`[appearance-coverage-override] applied=1 ${overrideFile}\n`
					);
					return readFileSync(overrideFile, "utf8");
				},
				name: "appearance-coverage-override",
			},
		]
	: [];

export default mergeConfig(base, {
	cacheDir: `${cacheRoot}/${harnessName}`,
	plugins: overridePlugins,
	...(scanEntries[harnessName]
		? { optimizeDeps: { entries: scanEntries[harnessName] } }
		: {}),
});
