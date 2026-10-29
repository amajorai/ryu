import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig, type Plugin, type UserConfig } from "vite";
import billing from "./vite.billing-tab-proof.config.ts";
import account from "./vite.developer-account-sessions-settings-proof.config.ts";
import profile from "./vite.profile-tab-settings-proof.config.ts";
import teams from "./vite.teams-billing-settings-proof.config.ts";

// Serves one of the existing Account / Profile / Billing / Teams billing proof
// harnesses unchanged, except that the dependency cache lives under the
// caller-owned scratch directory instead of the shared system temp directory.
const harnesses: Record<string, UserConfig> = {
	account,
	billing,
	profile,
	teams,
};

const harnessName = process.env.RYU_ACCOUNT_BILLING_HARNESS ?? "";
const base = harnesses[harnessName];
if (!base) {
	throw new Error(
		`RYU_ACCOUNT_BILLING_HARNESS must be one of ${Object.keys(harnesses).join(", ")}`
	);
}
const cacheRoot =
	process.env.RYU_ACCOUNT_BILLING_VITE_CACHE ?? "/tmp/account-billing-pw/vite";

// Opt-in for mutant runs only: `<file under src/components/settings>=<scratch
// body>` serves the scratch body in place of one shipping settings module, so
// no shipping file is edited to prove that a browser assertion catches a
// regression.
const override = process.env.RYU_ACCOUNT_BILLING_OVERRIDE ?? "";
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
							`[account-billing-override] applied=1 ${overrideFile}\n`
						);
						return readFileSync(overrideFile, "utf8");
					},
					name: "account-billing-override",
				},
			]
		: [];

export default mergeConfig(base, {
	cacheDir: `${cacheRoot}/${harnessName}`,
	plugins: overridePlugins,
});
