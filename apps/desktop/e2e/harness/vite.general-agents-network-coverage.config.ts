import { existsSync } from "node:fs";
import path from "node:path";
import { mergeConfig, type PluginOption, type UserConfig } from "vite";

// Serves one existing settings proof harness, chosen by
// RYU_GENERAL_AGENTS_NETWORK_HARNESS (a config file name next to this one or
// in e2e/), with a /tmp dependency cache so revalidation runs never write
// Vite's cache into the checkout. Port, root, aliases and plugins come from the
// harness's own config unchanged. RYU_GENERAL_AGENTS_NETWORK_VITE_PLUGINS may
// name an absolute module path whose default export is a list of extra Vite
// plugins (for example a scratch mutation-testing loader kept outside the
// checkout); it is unset in ordinary runs.
const harness = process.env.RYU_GENERAL_AGENTS_NETWORK_HARNESS;
if (!harness || harness.includes("/") || !harness.endsWith(".ts")) {
	throw new Error(
		"Set RYU_GENERAL_AGENTS_NETWORK_HARNESS to an existing harness config file name"
	);
}
const candidates = [
	path.resolve(import.meta.dirname, harness),
	path.resolve(import.meta.dirname, "..", harness),
];
const file = candidates.find((candidate) => existsSync(candidate));
if (!file) {
	throw new Error(`Unknown harness config ${harness}`);
}
const base = (await import(file)).default as UserConfig;
const cacheRoot =
	process.env.RYU_GENERAL_AGENTS_NETWORK_VITE_CACHE ??
	"/tmp/general-agents-network-coverage/vite-cache";

const extraPluginsModule = process.env.RYU_GENERAL_AGENTS_NETWORK_VITE_PLUGINS;
const extraPlugins: PluginOption[] = extraPluginsModule
	? ((await import(extraPluginsModule)).default as PluginOption[])
	: [];

export default mergeConfig(base, {
	cacheDir: path.join(cacheRoot, harness.replace(/\.ts$/, "")),
	plugins: extraPlugins,
});
