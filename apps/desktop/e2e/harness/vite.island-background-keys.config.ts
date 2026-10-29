import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig, type Plugin, type UserConfig } from "vite";

// Serves one existing settings proof harness unchanged for the
// island-background-keys coverage run. Only the port and the dependency cache
// move, so this run never collides with another agent's harness on the shared
// host and never writes into the checkout's node_modules cache.
const harnessName = process.env.RYU_IBK_HARNESS ?? "";
const cacheRoot = process.env.RYU_IBK_VITE_CACHE ?? "/tmp/ibk-pw/vite";
const port = Number(process.env.RYU_IBK_PORT ?? "0");
if (!(Number.isInteger(port) && port > 0)) {
	throw new Error("RYU_IBK_PORT must name the port this harness serves on");
}

const loaders: Record<string, () => Promise<{ default: UserConfig }>> = {
	background: () => import("./vite.background-customization-proof.config.ts"),
	// Settings and the sidebar ChatRow together: the quick-reply harness config
	// already carries the aliases ChatRow needs, and serves every page in this
	// directory, including island-background-keys-click-modifiers.html.
	"click-modifiers": () => import("./vite.quick-reply-proof.config.ts"),
	island: () => import("./vite.island-settings-proof.config.ts"),
	keyboard: () => import("./vite.keyboard-shortcuts-proof.config.ts"),
	"keyboard-authority": () =>
		import("./vite.keyboard-shortcuts-authority-proof.config.ts"),
	split: () => import("./vite.split-preset-settings-proof.config.ts"),
	timezone: () => {
		// The time/date harness refuses to start without an absolute owned cache.
		process.env.RYU_TIME_DATES_VITE_CACHE = `${cacheRoot}/timezone`;
		process.env.RYU_E2E_PORT = String(port);
		// Its icon plugin also requires caller-owned paths: the map comes from
		// `node tools/generate-installed-icon-map.mjs apps/desktop <map>`.
		process.env.RYU_APPEARANCE_ICON_MAP ??= `${cacheRoot}/../icons/installed-icon-map.json`;
		process.env.RYU_APPEARANCE_ICON_DIAGNOSTIC ??= `${cacheRoot}/../icons/diagnostic.json`;
		return import("./vite.time-dates.config.ts");
	},
};
const load = loaders[harnessName];
if (!load) {
	throw new Error(
		`RYU_IBK_HARNESS must be one of ${Object.keys(loaders).join(", ")}`
	);
}
const base = (await load()).default;

// Opt-in for baseline and mutant runs only: serve a scratch body in place of
// one shipping module, so no shipping file is edited to run them.
const overrideTarget = process.env.RYU_IBK_OVERRIDE_TARGET;
const overrideFile = process.env.RYU_IBK_OVERRIDE_FILE;
const overridePlugins: Plugin[] =
	overrideTarget && overrideFile
		? [
				{
					enforce: "pre",
					load(id) {
						if (path.resolve(id.split("?")[0] ?? "") !== overrideTarget) {
							return null;
						}
						process.stderr.write(
							`[island-background-keys-override] applied=1 ${overrideFile}\n`
						);
						return readFileSync(overrideFile, "utf8");
					},
					name: "island-background-keys-override",
				},
			]
		: [];

export default mergeConfig(base, {
	cacheDir: `${cacheRoot}/${harnessName}`,
	plugins: overridePlugins,
	server: { host: "127.0.0.1", port, strictPort: true },
});
