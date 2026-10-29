import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig, type Plugin, type UserConfig } from "vite";
import dangerZone from "./vite.desktop-danger-zone-proof.config.ts";
import developer from "./vite.developer-account-sessions-settings-proof.config.ts";
import storage from "./vite.gateway-storage-settings-proof.config.ts";

// Serves one of the three existing Developer / Danger Zone / Storage proof
// harnesses unchanged, except that the dependency cache lives under the
// caller-owned scratch directory instead of the shared checkout.
const harnesses: Record<string, UserConfig> = {
	danger: dangerZone,
	developer,
	storage,
};

const harnessName = process.env.RYU_DEVELOPER_STORAGE_HARNESS ?? "";
const base = harnesses[harnessName];
if (!base) {
	throw new Error(
		`RYU_DEVELOPER_STORAGE_HARNESS must be one of ${Object.keys(harnesses).join(", ")}`
	);
}
const cacheRoot =
	process.env.RYU_DEVELOPER_STORAGE_VITE_CACHE ??
	"/tmp/developer-storage-pw/vite";

// Opt-in for mutant runs only: `<shipping file>=<scratch body>` serves the
// scratch body in place of one shipping settings module, so no shipping file
// is edited to prove that a browser assertion catches a regression.
const override = process.env.RYU_DEVELOPER_STORAGE_OVERRIDE ?? "";
const [overrideName, overrideFile] = override.split("=");
const overrideTarget = overrideName
	? path.resolve(
			import.meta.dirname,
			"../../src/components/settings",
			overrideName
		)
	: "";
const overridePlugins: Plugin[] =
	overrideTarget && overrideFile
		? [
				{
					enforce: "pre",
					load(id) {
						if (id.split("?")[0] !== overrideTarget) {
							return null;
						}
						process.stderr.write(
							`[developer-storage-override] applied=1 ${overrideFile}\n`
						);
						return readFileSync(overrideFile, "utf8");
					},
					name: "developer-storage-override",
				},
			]
		: [];

export default mergeConfig(base, {
	cacheDir: `${cacheRoot}/${harnessName}`,
	plugins: overridePlugins,
});
